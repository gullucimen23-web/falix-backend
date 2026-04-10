import express from "express";
import multer from "multer";
import cors from "cors";
import fs from "fs";
import OpenAI from "openai";
import dotenv from "dotenv";
import admin from "firebase-admin";

dotenv.config();

const app = express();
const upload = multer({ dest: "uploads/" });

app.use(cors());
app.use(express.json());

// ✅ HEALTH CHECK
app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "falix-backend",
  });
});

// ✅ FIREBASE
const serviceAccount = JSON.parse(
  fs.readFileSync("./serviceAccountKey.json", "utf8")
);

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();

// ✅ OPENAI
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// 🔥 RATE LIMIT
const userCooldown = {};
const dailyIpUsage = {};

function getTodayKey() {
  return new Date().toISOString().slice(0, 10);
}

function applyRateProtection(req, res, next) {
  const ip =
    req.ip ||
    req.headers["x-forwarded-for"] ||
    req.socket?.remoteAddress ||
    "unknown";

  const now = Date.now();
  const todayKey = getTodayKey();

  if (userCooldown[ip] && now - userCooldown[ip] < 3000) {
    return res.status(429).json({
      error: "Çok hızlı istek attın.",
    });
  }

  if (!dailyIpUsage[ip] || dailyIpUsage[ip].date !== todayKey) {
    dailyIpUsage[ip] = { date: todayKey, count: 0 };
  }

  if (dailyIpUsage[ip].count >= 100) {
    return res.status(429).json({
      error: "Günlük limit doldu",
    });
  }

  userCooldown[ip] = now;
  dailyIpUsage[ip].count += 1;
  next();
}

app.use(applyRateProtection);

// 🔐 AUTH
async function authMiddleware(req, res, next) {
  try {
    const token = req.headers.authorization?.split("Bearer ")[1];

    if (!token) {
      return res.status(401).json({ error: "Token yok" });
    }

    const decoded = await admin.auth().verifyIdToken(token);
    req.uid = decoded.uid;

    next();
  } catch (e) {
    return res.status(401).json({ error: "Unauthorized" });
  }
}

// 🎯 TAROT
app.post("/tarot", authMiddleware, async (req, res) => {
  try {
    const { cards = [], topic = "genel" } = req.body;

    const response = await client.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        {
          role: "user",
          content: `Konu: ${topic} Kartlar: ${cards.join(", ")}`,
        },
      ],
    });

    const result =
      response.choices?.[0]?.message?.content || "Yorum yok";

    res.json({ result });
  } catch (e) {
    res.status(500).json({ error: "Tarot hata" });
  }
});

// 🚀 SERVER
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("🚀 Server running on port", PORT);
});