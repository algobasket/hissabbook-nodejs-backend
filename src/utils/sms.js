// SMS utility for sending SMS via Fast2SMS
const axios = require('axios');
const qs = require('qs');

function formatPhoneNumber(phone) {
  if (!phone) {
    throw new Error('Phone number is required');
  }

  // Remove any non-digit characters (including +, spaces, hyphens)
  let cleaned = phone.replace(/\D/g, "");
  
  if (!cleaned || cleaned.length < 10) {
    throw new Error(`Invalid phone number format: ${phone}. Phone number is too short.`);
  }
  
  // Handle different phone number formats for Indian numbers
  // If phone starts with 0 and is 11 digits (e.g., 09876543210), replace 0 with 91
  if (cleaned.startsWith("0") && cleaned.length === 11) {
    cleaned = "91" + cleaned.substring(1);
  }
  // If phone is exactly 10 digits (e.g., 9876543210), prepend country code 91
  else if (cleaned.length === 10) {
    cleaned = "91" + cleaned;
  }
  // If phone already starts with 91, validate it's proper length (12 digits for India)
  else if (cleaned.startsWith("91") && cleaned.length === 12) {
    // Already properly formatted, use as is
  }
  // If phone has country code but not 91, or is longer, validate length
  else if (cleaned.length > 15) {
    throw new Error(`Invalid phone number format: ${phone}. Phone number is too long (${cleaned.length} digits).`);
  }
  
  // Final validation: should be 10-15 digits after formatting
  if (cleaned.length < 10 || cleaned.length > 15) {
    throw new Error(`Invalid phone number format: ${phone}. Expected 10-15 digits, got ${cleaned.length} after formatting.`);
  }
  
  return cleaned;
}

async function sendSms({ phone, message }) {
  const apiKey = process.env.FAST2SMS_API_KEY;
  const otpUrl = "https://www.fast2sms.com/dev/bulkV2";
  const scheduleTime = process.env.FAST2SMS_SCHEDULE_TIME || undefined;

  if (!apiKey) {
    throw new Error('Fast2SMS API key missing. Please set FAST2SMS_API_KEY environment variable.');
  }

  // Format phone number (remove +, spaces, etc.)
  let formattedPhone;
  try {
    formattedPhone = formatPhoneNumber(phone);
  } catch (error) {
    throw new Error(`Phone number validation failed: ${error.message}`);
  }

  // Fast2SMS route "q" expects 10-digit number for Indian numbers
  // Extract last 10 digits if the number starts with 91 (Indian country code)
  let phoneForSms = formattedPhone;
  if (formattedPhone.startsWith("91") && formattedPhone.length === 12) {
    phoneForSms = formattedPhone.substring(2); // Remove "91" prefix, keep last 10 digits
  } else if (formattedPhone.length > 10) {
    // For other countries, take last 10 digits
    phoneForSms = formattedPhone.substring(formattedPhone.length - 10);
  }

  // Build query parameters
  const params = {
    authorization: apiKey,
    route: "q",
    message: message,
    numbers: phoneForSms,
    schedule_time: scheduleTime || "",
    flash: "0",
  };

  try {
    const response = await axios.get(otpUrl, {
      params: params,
      paramsSerializer: params => qs.stringify(params),
    });
    
    const data = response.data;

    // Fast2SMS API returns success when data.return is true
    if (!data || data.return === false) {
      const errorMessage = data?.message
        ? Array.isArray(data.message)
          ? data.message.join(", ")
          : data.message
        : "Fast2SMS returned false or no response";
      
      throw new Error(`Fast2SMS error: ${errorMessage}`);
    }

    return {
      success: true,
      requestId: data.request_id,
      message: data.message,
    };
  } catch (error) {
    if (error.response) {
      const errorMessage = error.response.data?.message
        ? Array.isArray(error.response.data.message)
          ? error.response.data.message.join(", ")
          : error.response.data.message
        : error.message;
      throw new Error(`Fast2SMS request failed: ${errorMessage}`);
    }
    throw new Error(`Fast2SMS request failed: ${error.message}`);
  }
}

async function sendInviteSms({ phone, businessName, inviteLink, role, inviterName }) {
  const roleText = role === 'Partner' ? 'Business Partner' : 'Staff Member';
  
  // Format SMS message with URL on a new line for better clickability
  // Put the URL on its own line to ensure it's recognized as clickable by SMS clients
  // Some SMS clients require URLs to be on a separate line or properly formatted
  const message = `${inviterName || 'Someone'} invited you to join ${businessName} as ${roleText} on HissabBook.\n\nAccept invitation:\n${inviteLink}`;

  try {
    const result = await sendSms({ phone, message });
    return {
      success: true,
      requestId: result.requestId,
    };
  } catch (error) {
    throw new Error(`Failed to send SMS: ${error.message}`);
  }
}

module.exports = {
  sendSms,
  sendInviteSms,
  formatPhoneNumber,
};

