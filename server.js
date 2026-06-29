import express from "express";
import cors from "cors";
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";
import rateLimit from "express-rate-limit";

const app = express();

// ── Environment Variables ──────────────────────────────────────────────────────
const GEMINI_API_KEY       = process.env.GEMINI_API_KEY;
const STRIPE_SECRET_KEY    = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const PORT                 = process.env.PORT || 3000;

// ── Clients ───────────────────────────────────────────────────────────────────
const stripe   = new Stripe(STRIPE_SECRET_KEY);
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ── Middleware ────────────────────────────────────────────────────────────────

// Stripe webhook needs raw body — must come BEFORE express.json()
app.use("/api/webhook", express.raw({ type: "application/json" }));

// All other routes use JSON
app.use(express.json());

// CORS — allow your frontend domains
app.use(cors({
  origin: true,
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

// Rate limiting — 20 requests / hour / IP
const limiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  message: { error: "Too many requests. Please wait before trying again." },
  validate: { xForwardedForHeader: false }
});
app.use("/api/generate", limiter);

// ── Health Check ──────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "MD Neural proxy is running", version: "2.0.0" });
});

// ── /api/generate — Gemini AI ─────────────────────────────────────────────────
app.post("/api/generate", async (req, res) => {
  try {
    const { prompt, max_tokens = 2000 } = req.body;

    if (!prompt) {
      return res.status(400).json({ error: "prompt is required" });
    }

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            maxOutputTokens: max_tokens,
            temperature: 0.7
          }
        })
      }
    );

    if (!geminiRes.ok) {
      const err = await geminiRes.json();
      console.error("Gemini error:", err);
      return res.status(geminiRes.status).json({ error: err.error?.message || "Gemini API error" });
    }

    const data = await geminiRes.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";

    res.json({ result: text });
  } catch (err) {
    console.error("/api/generate error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── /api/checkout — Stripe Checkout Session ───────────────────────────────────
app.post("/api/checkout", async (req, res) => {
  try {
    const { priceId, userEmail } = req.body;

    if (!priceId || !userEmail) {
      return res.status(400).json({ error: "priceId and userEmail are required" });
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "subscription",
      customer_email: userEmail,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: "https://md-neural.com/tool.html?payment=success",
      cancel_url:  "https://md-neural.com/tool.html?payment=cancelled",
      metadata: { userEmail }
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("/api/checkout error:", err);
    res.status(500).json({ error: err.message || "Checkout session failed" });
  }
});

// ── /api/webhook — Stripe Webhook ─────────────────────────────────────────────
app.post("/api/webhook", async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("Webhook signature error:", err.message);
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }

  if (event.type === "checkout.session.completed") {
    const session  = event.data.object;
    const email    = session.metadata?.userEmail || session.customer_email;

    if (email) {
      const { error } = await supabase
        .from("profiles")
        .update({ is_pro: true })
        .eq("email", email);

      if (error) {
        console.error("Supabase update error:", error);
        return res.status(500).json({ error: "Failed to upgrade user" });
      }

      console.log(`✅ Upgraded to Pro: ${email}`);
    }
  }

  res.json({ received: true });
});

// ── Start Server ──────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`MD Neural proxy running on port ${PORT}`);
});
