const express = require('express');
const twilio = require('twilio');
const jsforce = require('jsforce');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- Twilio Config ---
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const client = twilio(accountSid, authToken);

// --- Salesforce Config ---
const SF_LOGIN_URL = process.env.SF_LOGIN_URL || 'https://login.salesforce.com';
const SF_USERNAME = process.env.SF_USERNAME;
const SF_PASSWORD = process.env.SF_PASSWORD;
const SF_SECURITY_TOKEN = process.env.SF_SECURITY_TOKEN;
const SF_RECORD_TYPE_ID = '012Uj000004dp1xIAA'; // Business Lending

// Reusable Salesforce connection
let sfConn = null;
async function getSalesforceConnection() {
  if (sfConn && sfConn.accessToken) {
    try {
      await sfConn.identity();
      return sfConn;
    } catch {
      sfConn = null;
    }
  }
  sfConn = new jsforce.Connection({ loginUrl: SF_LOGIN_URL });
  await sfConn.login(SF_USERNAME, SF_PASSWORD + SF_SECURITY_TOKEN);
  console.log('Salesforce connected:', sfConn.userInfo);
  return sfConn;
}

// --- Helper: validate email format ---
function isValidEmail(val) {
  if (!val || val === 'Unknown' || val === 'unknown' || val === 'N/A' || val === 'n/a' || val === 'none') return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val);
}

// --- Helper: normalize monthly revenue string to number ---
function parseRevenue(raw) {
  if (!raw || raw === 'Unknown' || raw === 'unknown') return undefined;
  // Remove $ signs, commas, spaces, and "k"/"K" shorthand
  let cleaned = raw.replace(/[\$,\s]/g, '');
  if (/k$/i.test(cleaned)) {
    return parseFloat(cleaned.replace(/k$/i, '')) * 1000;
  }
  if (/m$/i.test(cleaned)) {
    return parseFloat(cleaned.replace(/m$/i, '')) * 1000000;
  }
  const num = parseFloat(cleaned);
  return isNaN(num) ? undefined : num;
}

// --- Helper: normalize funding amount range ---
function normalizeFundingAmount(raw) {
  if (!raw || raw === 'Unknown' || raw === 'unknown') return undefined;
  return raw;
}

// --- Lookup Lead by Phone Number ---
app.post('/lookup-lead', async (req, res) => {
  try {
    const callerPhone = req.body.caller_phone;
    if (!callerPhone) {
      return res.status(200).json({ found: false, message: 'No phone number provided' });
    }

    const digits = callerPhone.replace(/\D/g, '');
    const last10 = digits.length > 10 ? digits.slice(-10) : digits;

    // Build multiple phone format variations for matching
    const fmt1 = '(' + last10.slice(0, 3) + ') ' + last10.slice(3, 6) + '-' + last10.slice(6);
    const fmt2 = last10.slice(0, 3) + '-' + last10.slice(3, 6) + '-' + last10.slice(6);
    const fmt3 = '+1' + last10;

    const conn = await getSalesforceConnection();
    const query =
      "SELECT Id, FirstName, LastName, Phone, Status, Company, " +
      "Buisness_Name__c, Business_Industry__c, " +
      "Comments__c, CreatedDate FROM Lead WHERE RecordTypeId = '" + SF_RECORD_TYPE_ID + "' AND " +
      "(Phone LIKE '%" + last10 + "%' OR Phone LIKE '%" + fmt1 + "%' OR Phone LIKE '%" + fmt2 + "%' OR Phone LIKE '%" + fmt3 + "%') " +
      "ORDER BY CreatedDate DESC LIMIT 1";

    const result = await conn.query(query);

    if (result.totalSize === 0) {
      return res.status(200).json({ found: false, message: 'No existing lead found' });
    }

    const lead = result.records[0];
    console.log('Lead found:', callerPhone, lead.Id, lead.Status);

    return res.status(200).json({
      found: true,
      lead_id: lead.Id,
      first_name: lead.FirstName,
      last_name: lead.LastName,
      status: lead.Status,
      business_name: lead.Buisness_Name__c,
      industry: lead.Business_Industry__c,
      comments: lead.Comments__c,
      message: 'Existing lead found'
    });
  } catch (err) {
    console.error('Lookup lead error:', err.message);
    return res.status(200).json({ found: false, message: 'Error: ' + err.message });
  }
});

// --- Main Endpoint ---
app.post('/call-completed', async (req, res) => {
  // Respond immediately so ElevenLabs doesn't timeout
  res.status(200).json({ success: true });

  const body = req.body;

  // Parse fields from ElevenLabs webhook tool
  const firstName = body.first_name || body.caller_name || 'Unknown';
  const lastName = body.last_name;
  const callerPhone = body.caller_phone || 'Unknown';
  const email = body.email;
  const callIntent = body.call_intent || body.intent || 'Unknown';
  const businessName = body.business_name || 'Unknown';
  const entityType = body.entity_type || 'Unknown';
  const timeInBusiness = body.time_in_business || 'Unknown';
  const monthlyRevenue = body.monthly_revenue || 'Unknown';
  const fundingAmount = body.funding_amount || 'Unknown';
  const industry = body.industry || 'Unknown';
  const notes = body.notes;

  // --- Console Log ---
  console.log('=============================');
  console.log('NEW WLL MCA CALL LOGGED');
  console.log('=============================');
  console.log('Name:', firstName, lastName);
  console.log('Phone:', callerPhone);
  console.log('Email:', email);
  console.log('Intent:', callIntent);
  console.log('Business:', businessName);
  console.log('Entity Type:', entityType);
  console.log('Time in Business:', timeInBusiness);
  console.log('Monthly Revenue:', monthlyRevenue);
  console.log('Funding Amount:', fundingAmount);
  console.log('Industry:', industry);
  console.log('Notes:', notes);
  console.log('=============================');

  // --- Create Salesforce Lead ---
  try {
    const conn = await getSalesforceConnection();

    // Build comments field with call context
    const commentsLines = [
      `Call Intent: ${callIntent}`,
      `Entity Type: ${entityType}`,
      `Time in Business: ${timeInBusiness}`,
      `Monthly Revenue: ${monthlyRevenue}`,
      `Funding Amount Requested: ${fundingAmount}`,
      notes ? `Agent Notes: ${notes}` : null
    ].filter(Boolean).join('\n');

    const revenueNum = parseRevenue(monthlyRevenue);

    const leadData = {
      RecordTypeId: SF_RECORD_TYPE_ID,
      FirstName: firstName !== 'Unknown' ? firstName : undefined,
      LastName: lastName || (firstName !== 'Unknown' ? firstName : 'Unknown Caller'),
      Phone: callerPhone !== 'Unknown' ? callerPhone : undefined,
      Email: isValidEmail(email) ? email : undefined,
      Company: businessName !== 'Unknown' ? businessName : 'Unknown Business',
      Status: 'New',
      LeadSource: 'Phone Inquiry',
      Buisness_Name__c: businessName !== 'Unknown' ? businessName : undefined,
      Business_Industry__c: industry !== 'Unknown' ? industry : undefined,
      AnnualRevenue: revenueNum ? revenueNum * 12 : undefined,
      Comments__c: commentsLines || undefined
    };

    // Clean undefined values
    Object.keys(leadData).forEach(key => {
      if (leadData[key] === undefined) delete leadData[key];
    });

    console.log('Creating SF Lead with data:', JSON.stringify(leadData));

    // Use REST API with Sforce-Auto-Assign: false to prevent assignment rules
    // from resetting RecordTypeId to the owner's profile default
    const result = await conn.request({
      method: 'POST',
      url: '/services/data/v' + conn.version + '/sobjects/Lead',
      body: JSON.stringify(leadData),
      headers: {
        'Content-Type': 'application/json',
        'Sforce-Auto-Assign': 'false'
      }
    });

    if (result.success) {
      console.log('Salesforce Lead created:', result);
    } else {
      console.error('Salesforce Lead creation failed:', result.errors);
    }
  } catch (err) {
    console.error('Salesforce error:', err.message);
  }

  // --- Hot Lead SMS Alert ---
  // Hot lead = 3+ months in business AND $10k+ MRR
  const revenueVal = parseRevenue(monthlyRevenue);
  const timeLower = (timeInBusiness || '').toLowerCase();
  const isQualified =
    revenueVal && revenueVal >= 10000 &&
    !timeLower.includes('not yet') &&
    !timeLower.includes('not started') &&
    !(timeLower.includes('1') && timeLower.includes('month') && !timeLower.includes('12'));

  if (isQualified) {
    try {
      await client.messages.create({
        body: [
          'ð¥ HOT MCA LEAD - CALL NOW',
          `Name: ${firstName} ${lastName}`,
          `Phone: ${callerPhone}`,
          `Business: ${businessName}`,
          `Monthly Revenue: ${monthlyRevenue}`,
          `Time in Business: ${timeInBusiness}`,
          `Funding Needed: ${fundingAmount}`,
          `Industry: ${industry}`,
          notes ? `Notes: ${notes}` : null
        ].filter(Boolean).join('\n'),
        from: process.env.TWILIO_PHONE_NUMBER,
        to: process.env.MY_CELL_NUMBER
      });
      console.log('Hot lead SMS alert sent');
    } catch (err) {
      console.error('SMS alert failed:', err);
    }
  }
});

app.get('/', (req, res) => {
  res.send('WLL MCA call logger is running');
});

app.listen(process.env.PORT || 3000, () => {
  console.log('WLL MCA call logger is live');
});
