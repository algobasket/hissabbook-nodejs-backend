import axios from "axios";
import qs from "qs";

async function sendTestOTP() {
  const apiUrl = "https://www.fast2sms.com/dev/bulkV2";

  // Your Fast2SMS authorization key (replace with your own key)
  const API_KEY = "PfDX4CojBOuH0U3yLdF6w2arxqnScI1ZeV9kmTbtl5RghNpJGWazSufLIYGFT2R0m9jvQ4cN8Kd1oV3U";

  // Test mobile number (must be 10 digits)
  const number = "9876543210";

  // OTP value (numeric)
  const otpValue = "123456";

  // Build query params
  const params = {
    authorization: API_KEY,
    route: "otp",
    variables_values: otpValue,
    numbers: number,
    flash: "0",
  };

  try { 
    const response = await axios.get(apiUrl, {
      params: params,
      paramsSerializer: params => qs.stringify(params),
    });

    console.log("SMS API Response:");
    console.log(response.data);

  } catch (error) {
    console.error("Error sending SMS:", error.response?.data || error.message);
  }
}

sendTestOTP(); 


//http://195.201.12.185/http-api.php?username=Newotpuser&password=123456&senderid=PLYCRD&route=2&number={{mobile}}&message=Use {{otp}}