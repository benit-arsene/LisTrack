const INTOUCH_USERNAME = process.env.INTOUCH_USERNAME || "";
const INTOUCH_ACCOUNT_NO = process.env.INTOUCH_ACCOUNT_NO || "";
const INTOUCH_PARTNER_PASSWORD = process.env.INTOUCH_PARTNER_PASSWORD || "";
const INTOUCH_API_URL =
  process.env.INTOUCH_API_URL || "https://api.intouchpay.co.rw";
const DONATION_IS_LIVE = !!(
  INTOUCH_USERNAME &&
  INTOUCH_ACCOUNT_NO &&
  INTOUCH_PARTNER_PASSWORD
);

function generateTxRef() {
  const prefix = "LIS";
  const ts = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).substring(2, 8).toUpperCase();
  return `${prefix}-${ts}-${rand}`;
}

function normalizePhone(phone) {
  return String(phone)
    .replace(/[\s\-]/g, "")
    .replace(/^(\+|00)/, "");
}

function isValidRwandanPhone(phone) {
  return /^07\d{8}$/.test(phone) || /^2507\d{8}$/.test(phone);
}

function createIntouchPayload(cleanedPhone, donationAmount, txRef) {
  return {
    username: INTOUCH_USERNAME,
    account_no: INTOUCH_ACCOUNT_NO,
    partner_password: INTOUCH_PARTNER_PASSWORD,
    action: "1",
    amount: String(donationAmount),
    phone: cleanedPhone,
    external_id: txRef,
  };
}

async function initiateDonationHandler(req, res) {
  try {
    const { phone, amount } = req.body || {};

    if (!phone || !amount) {
      return res.status(400).json({
        success: false,
        error: "Please provide both phone number and amount.",
      });
    }

    const cleanedPhone = normalizePhone(phone);
    if (!isValidRwandanPhone(cleanedPhone)) {
      return res.status(400).json({
        success: false,
        error: "Please enter a valid Rwandan phone number (e.g., 0788123456).",
      });
    }

    const donationAmount = parseInt(amount, 10);
    if (
      isNaN(donationAmount) ||
      donationAmount < 100 ||
      donationAmount > 1000000
    ) {
      return res.status(400).json({
        success: false,
        error: "Amount must be between 100 RWF and 1,000,000 RWF.",
      });
    }

    const txRef = generateTxRef();

    if (!DONATION_IS_LIVE) {
      console.log(
        `[donate] DEMO: Would send ${donationAmount} RWF from ${cleanedPhone} (ref: ${txRef})`,
      );
      return res.json({
        success: true,
        demo: true,
        txRef,
        message:
          "🎉 Demo mode! In production, a MoMo USSD push would be sent to your phone. Ready to go live once IntouchPay credentials are configured.",
      });
    }

    const intouchPayload = createIntouchPayload(
      cleanedPhone,
      donationAmount,
      txRef,
    );
    console.log(
      `[donate] Initiating payment: ${donationAmount} RWF to ${cleanedPhone} (ref: ${txRef})`,
    );

    const intouchResponse = await fetch(`${INTOUCH_API_URL}/request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(intouchPayload),
    });

    const intouchResult = await intouchResponse.json();

    if (intouchResponse.ok && intouchResult?.status === "success") {
      console.log(`[donate] Payment initiated successfully: ${txRef}`);
      return res.json({
        success: true,
        txRef,
        message:
          "✅ MoMo USSD push sent! Check your phone and enter your PIN to complete the donation.",
      });
    }

    console.error("[donate] Intouch API error:", intouchResult);
    return res.status(502).json({
      success: false,
      error:
        intouchResult?.message ||
        "Payment gateway error. Please try again later.",
    });
  } catch (err) {
    console.error("[donate] Error initiating payment:", err);
    return res.status(500).json({
      success: false,
      error: "Server error. Please try again later.",
    });
  }
}

function donateCallbackHandler(req, res) {
  const payload = req.body;
  console.log("[donate] Callback received:", JSON.stringify(payload));
  return res.status(200).json({ status: "ok" });
}

function donateStatusHandler(req, res) {
  return res.json({
    live: DONATION_IS_LIVE,
    currency: "RWF",
    methods: ["MTN MoMo", "Airtel Money"],
  });
}

function registerDonationRoutes(app) {
  app.get("/api/donate/status", donateStatusHandler);
  app.post("/api/donate/initiate", initiateDonationHandler);
  app.post("/api/donate/callback", donateCallbackHandler);
}

module.exports = registerDonationRoutes;
