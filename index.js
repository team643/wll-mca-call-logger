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

// --- Helper: check if value is usable (not empty/unknown) ---
function isUsable(val) {
  if (!val) return false;
  const lower = val.toString().toLowerCase().trim();
  return lower !== '' && lower !== 'unknown' && lower !== 'n/a' && lower !== 'none' && lower !== 'not provided';
}

// --- Helper: normalize revenue/dollar string to number ---
function parseDollarAmount(raw) {
  if (!raw || !isUsable(raw)) return undefined;
  let cleaned = raw.toString().replace(/[\$,\s]/g, '');
  if (/k$/i.test(cleaned)) {
    return parseFloat(cleaned.replace(/k$/i, '')) * 1000;
  }
  if (/m$/i.test(cleaned)) {
    return parseFloat(cleaned.replace(/m$/i, '')) * 1000000;
  }
  const num = parseFloat(cleaned);
  return isNaN(num) ? undefined : num;
}

// --- Helper: parse time-in-business to numeric years ---
function parseYearsInBusiness(raw) {
  if (!raw || !isUsable(raw)) return undefined;
  const lower = raw.toString().toLowerCase().trim();
  const monthMatch = lower.match(/(\d+\.?\d*)\s*month/);
  if (monthMatch) {
    const months = parseFloat(monthMatch[1]);
    return Math.round(months / 12 * 10) / 10;
  }
  const yearMatch = lower.match(/(\d+\.?\d*)\s*year/);
  if (yearMatch) {
    return parseFloat(yearMatch[1]);
  }
  const num = parseFloat(lower);
  return isNaN(num) ? undefined : num;
}

// --- Helper: normalize entity type to match SF picklist values ---
function normalizeEntityType(raw) {
  if (!raw || !isUsable(raw)) return undefined;
  const lower = raw.toString().toLowerCase().trim();
  const mapping = {
    'llc': 'LLC',
    'limited liability company': 'LLC',
    'sole proprietorship': 'Sole Proprietorship',
    'sole prop': 'Sole Proprietorship',
    'sole-proprietorship': 'Sole Proprietorship',
    's-corp': 'S-Corp',
    's corp': 'S-Corp',
    'scorpion': 'S-Corp',
    'c-corp': 'C-Corp',
    'c corp': 'C-Corp',
    'corporation': 'Corporation',
    'corp': 'Corporation',
    'partnership': 'Partnership',
    'nonprofit': 'Nonprofit',
    'non-profit': 'Nonprofit',
    'non profit': 'Nonprofit',
  };
  return mapping[lower] || raw;
}

// --- Helper: normalize phone to last 10 digits ---
function normalizePhone(phone) {
  if (!phone || phone === 'Unknown') return null;
  const digits = phone.replace(/\D/g, '');
  return digits.length > 10 ? digits.slice(-10) : digits;
}

// --- Helper: find existing lead by phone number ---
async function findExistingLead(conn, phone, recordTypeId) {
  const last10 = normalizePhone(phone);
  if (!last10 || last10.length < 10) return null;

  const fmt1 = '(' + last10.slice(0,3) + ') ' + last10.slice(3,6) + '-' + last10.slice(6);
  const fmt2 = last10.slice(0,3) + '-' + last10.slice(3,6) + '-' + last10.slice(6);
  const fmt3 = '+1' + last10;

  const query = "SELECT Id, Phone, Status, Comments__c, CreatedDate FROM Lead WHERE RecordTypeId = '" + recordTypeId + "' AND " +
    "(Phone LIKE '%" + last10 + "%' OR Phone LIKE '%" + fmt1 + "%' OR Phone LIKE '%" + fmt2 + "%' OR Phone LIKE '%" + fmt3 + "%') " +
    "ORDER BY CreatedDate DESC LIMIT 1";

  const result = await conn.query(query);
  return result.totalSize > 0 ? result.records[0] : null;
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
    const fmt1 = '(' + last10.slice(0,3) + ') ' + last10.slice(3,6) + '-' + last10.slice(6);
    const fmt2 = last10.slice(0,3) + '-' + last10.slice(3,6) + '-' + last10.slice(6);
    const fmt3 = '+1' + last10;

    const conn = await getSalesforceConnection();
    const query = "SELECT Id, FirstName, LastName, Phone, Status, Company, " +
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

  // --- Create or Update Salesforce Lead ---
  try {
    const conn = await getSalesforceConnection();

    // Parse numeric values from conversational strings
    const revenueNum = parseDollarAmount(monthlyRevenue);
    const fundingNum = parseDollarAmount(fundingAmount);
    const yearsNum = parseYearsInBusiness(timeInBusiness);
    const entityNorm = normalizeEntityType(entityType);

    // Build call notes for Comments__c (supplementary context only)
    const newComments = [
      isUsable(callIntent) ? `Call Intent: ${callIntent}` : null,
      notes ? `Agent Notes: ${notes}` : null
    ].filter(Boolean).join('\n');

    const leadData = {
      RecordTypeId: SF_RECORD_TYPE_ID,
      FirstName: firstName !== 'Unknown' ? firstName : undefined,
      LastName: lastName || (firstName !== 'Unknown' ? firstName : 'Unknown Caller'),
      Phone: callerPhone !== 'Unknown' ? callerPhone : undefined,
      Email: isValidEmail(email) ? email : undefined,
      Company: businessName !== 'Unknown' ? businessName : 'Unknown Business',
      Status: 'New',
      LeadSource: 'Phone Inquiry',
      Buisness_Name__c: isUsable(businessName) ? businessName : undefined,
      Business_Industry__c: isUsable(industry) ? industry : undefined,
      Entity_Type__c: entityNorm || undefined,
      Years_In_Business__c: yearsNum || undefined,
      Monthly_Recurring_Revenue__c: revenueNum || undefined,
      Requested__c: fundingNum || undefined,
      Requested_Funding__c: fundingNum || undefined,
    };

    // Clean undefined values
    Object.keys(leadData).forEach(key => {
      if (leadData[key] === undefined) delete leadData[key];
    });

    // --- Duplicate Handling: Find existing lead by phone, update or create ---
    const existingLead = await findExistingLead(conn, callerPhone, SF_RECORD_TYPE_ID);

    if (existingLead) {
      // UPDATE existing lead
      const timestamp = new Date().toISOString();
      const prevComments = existingLead.Comments__c || '';
      const updatedComments = `[${timestamp}] Repeat call Ã¢ÂÂ updated with latest info.\n${newComments}\n---\n${prevComments}`.trim();

      // Remove fields that shouldn't be sent on update
      delete leadData.RecordTypeId;
      delete leadData.LeadSource;

      leadData.Comments__c = updatedComments;

      console.log('Updating existing SF Lead:', existingLead.Id);
      console.log('Update data:', JSON.stringify(leadData));

      const updateResult = await conn.request({
        method: 'PATCH',
        url: '/services/data/v' + conn.version + '/sobjects/Lead/' + existingLead.Id,
        body: JSON.stringify(leadData),
        headers: {
          'Content-Type': 'application/json',
          'Sforce-Auto-Assign': 'false'
        }
      });

      console.log('Salesforce Lead UPDATED:', existingLead.Id, updateResult || 'success (204)');
    } else {
      // CREATE new lead
      leadData.Comments__c = newComments || undefined;
      if (!leadData.Comments__c) delete leadData.Comments__c;

      console.log('Creating NEW SF Lead with data:', JSON.stringify(leadData));

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
        console.log('Salesforce Lead CREATED:', result);
      } else {
        console.error('Salesforce Lead creation failed:', result.errors);
      }
    }
  } catch (err) {
    console.error('Salesforce error:', err.message);
  }

  // --- Hot Lead SMS Alert ---
  const revenueVal = parseDollarAmount(monthlyRevenue);
  const timeLower = (timeInBusiness || '').toLowerCase();
  const isQualified = revenueVal && revenueVal >= 10000 &&
    !timeLower.includes('not yet') &&
    !timeLower.includes('not started') &&
    !(timeLower.includes('1') && timeLower.includes('month') && !timeLower.includes('12'));

  if (isQualified) {
    try {
      await client.messages.create({
        body: [
          '\ud83d\udd25 HOT MCA LEAD - CALL NOW',
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
