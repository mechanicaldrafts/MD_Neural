import express from "express";
import cors from "cors";
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";
import rateLimit from "express-rate-limit";

const app = express();

const ANTHROPIC_API_KEY     = process.env.ANTHROPIC_API_KEY;
const STRIPE_SECRET_KEY     = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const SUPABASE_URL          = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY;
const PORT                  = process.env.PORT || 3000;

const stripe   = new Stripe(STRIPE_SECRET_KEY);
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

app.use("/api/webhook", express.raw({ type: "application/json" }));
app.use(express.json());

app.use(cors({
  origin: true,
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

const limiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  message: { error: "Too many requests. Please wait before trying again." },
  validate: { xForwardedForHeader: false }
});
app.use("/api/generate", limiter);

app.get("/", (req, res) => {
  res.json({ status: "MD Neural proxy is running", version: "2.0.0" });
});

app.post("/api/generate", async (req, res) => {
  try {
    const { prompt, max_tokens = 2000 } = req.body;

    if (!prompt) {
      return res.status(400).json({ error: "prompt is required" });
    }

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: max_tokens,
        messages: [{ role: "user", content: prompt }]
      })
    });

    if (!response.ok) {
      const err = await response.json();
      console.error("Anthropic error:", err);
      return res.status(response.status).json({ error: err.error?.message || "AI API error" });
    }

    const data = await response.json();
    const text = data.content?.[0]?.text || "";

    res.json({ result: text });
  } catch (err) {
    console.error("/api/generate error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

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

app.post("/api/webhook", async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("Webhook signature error:", err.message);
    return res.status(400).json({ error: "Webhook Error: " + err.message });
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const email   = session.metadata?.userEmail || session.customer_email;

    if (email) {
      const { error } = await supabase
        .from("profiles")
        .update({ is_pro: true })
        .eq("email", email);

      if (error) {
        console.error("Supabase update error:", error);
        return res.status(500).json({ error: "Failed to upgrade user" });
      }

      console.log("Upgraded to Pro: " + email);
    }
  }

  res.json({ received: true });
});

app.listen(PORT, () => {
  console.log("MD Neural proxy running on port " + PORT);
});
