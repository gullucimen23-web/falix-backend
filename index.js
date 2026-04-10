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

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "falix-backend",
  });
});

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

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
      error: "Çok hızlı istek attın. Birkaç saniye bekleyip tekrar dene.",
    });
  }

  if (!dailyIpUsage[ip] || dailyIpUsage[ip].date !== todayKey) {
    dailyIpUsage[ip] = {
      date: todayKey,
      count: 0,
    };
  }

  if (dailyIpUsage[ip].count >= 100) {
    return res.status(429).json({
      error: "Bugün için backend kullanım limiti doldu.",
    });
  }

  userCooldown[ip] = now;
  dailyIpUsage[ip].count += 1;
  next();
}

app.use(applyRateProtection);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createWithRetry(payload, retries = 3) {
  let lastError;

  for (let i = 0; i < retries; i++) {
    try {
      return await client.chat.completions.create(payload);
    } catch (e) {
      lastError = e;

      if (!String(e).includes("429") || i === retries - 1) {
        throw e;
      }

      await sleep(1500 * (i + 1));
    }
  }

  throw lastError;
}

function safeUserName(value) {
  const raw = String(value || "").trim();
  if (!raw) return "Güzel Ruh";
  return raw.slice(0, 40);
}

async function authMiddleware(req, res, next) {
  try {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7)
      : "";

    if (!token) {
      return res.status(401).json({ error: "Unauthorized: token yok" });
    }

    const decoded = await admin.auth().verifyIdToken(token);
    req.uid = decoded.uid;
    next();
  } catch (e) {
    console.error("AUTH ERROR:", e);
    return res.status(401).json({ error: "Unauthorized" });
  }
}

async function checkUserAccess(uid, cost, reason) {
  const ref = db.collection("users").doc(uid);

  return db.runTransaction(async (tx) => {
    let snap = await tx.get(ref);

    // 🔥 USER YOKSA OLUŞTUR
    if (!snap.exists) {
      tx.set(ref, {
        coin: 100,
        premiumCoin: 0,
        premium: false,
        dailyUsage: 0,
        lastUsageDate: "",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      snap = await tx.get(ref); // 🔥 tekrar oku
    }

    const data = snap.data() || {};
    const today = getTodayKey();

    let coin = Number(data.coin || 0);
    const premium = Boolean(data.premium || false);
    let dailyUsage = Number(data.dailyUsage || 0);
    const lastUsageDate = String(data.lastUsageDate || "");

    if (!premium && lastUsageDate !== today) {
      dailyUsage = 0;
    }

    if (!premium && dailyUsage >= 5) {
      throw new Error("DAILY_LIMIT");
    }

    if (coin < cost) {
      throw new Error("NO_COIN");
    }

    const newCoin = coin - cost;

    tx.update(ref, {
      coin: newCoin,
      ...(premium
        ? {}
        : {
            dailyUsage: dailyUsage + 1,
            lastUsageDate: today,
          }),
    });

    const historyRef = ref.collection("coin_history").doc();
    tx.set(historyRef, {
      type: "spend",
      amount: -cost,
      balanceAfter: newCoin,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      meta: { reason },
    });

    return true;
  });
}
app.post("/tarot", authMiddleware, async (req, res) => {
  try {
    const { cards = [], topic = "genel", userName = "Güzel Ruh" } = req.body;
    const cleanName = safeUserName(userName);

    await checkUserAccess(req.uid, 80, "tarot_ai");

    const response = await createWithRetry({
      model: "gpt-4.1-mini",
      temperature: 0.9,
      messages: [
        {
          role: "system",
          content: `
Sen Falix uygulamasının premium tarot yorumcususun.

Kurallar:
- Türkçe yaz.
- Cevaba kullanıcının adıyla başla.
- İlk satır doğal şekilde "Merhaba ${cleanName}," diye başlasın.
- Yorum zarif, profesyonel, mistik ve akıcı olsun.
- Korkutucu, felaket odaklı veya kesin hüküm veren dil kullanma.
- Kart isimlerini doğal şekilde yorumun içine yedir.
- Emoji kullanma.
- Gereksiz tekrar yapma.
- Çok uzun yazma, 220-320 kelime civarı tut.
          `.trim(),
        },
        {
          role: "user",
          content: `Konu: ${topic}\nKartlar: ${cards.join(", ")}`,
        },
      ],
    });

    const result =
      response.choices?.[0]?.message?.content ||
      `Merhaba ${cleanName}, tarot yorumu üretilemedi.`;

    res.json({ result });
  } catch (e) {
    const errorText = String(e);

    if (errorText.includes("DAILY_LIMIT")) {
      return res.status(429).json({ error: "Günlük AI limitine ulaştın." });
    }

    if (errorText.includes("NO_COIN")) {
      return res.status(402).json({ error: "Coin yetersiz." });
    }

    if (errorText.includes("USER_NOT_FOUND")) {
      return res.status(404).json({ error: "Kullanıcı bulunamadı." });
    }

    if (errorText.includes("429")) {
      return res.status(429).json({
        error: "OpenAI limiti doldu veya çok sık istek atıldı. Biraz bekleyip tekrar dene.",
      });
    }

    console.error("TAROT ERROR:", e);
    return res.status(500).json({
      error: "Tarot çalışmadı",
      detail: errorText,
    });
  }
});

app.post("/coffee-vision", authMiddleware, upload.single("image"), async (req, res) => {
  const filePath = req.file?.path;

  try {
    if (!filePath) {
      return res.status(400).json({ error: "Foto yok" });
    }

    const cleanName = safeUserName(req.body?.userName);
    await checkUserAccess(req.uid, 120, "coffee_ai");

    const base64Image = fs.readFileSync(filePath, { encoding: "base64" });

    const response = await createWithRetry({
      model: "gpt-4.1-mini",
      response_format: { type: "json_object" },
      temperature: 0.9,
      messages: [
        {
          role: "system",
          content: `
Sen Falix uygulamasının premium kahve falı yorumcususun.

Türkçe yaz.
Sadece JSON döndür.

JSON formatı:
{
  "greeting": "Merhaba ${cleanName}, ...",
  "overall": "Genel enerji yorumu",
  "love": "Aşk yorumu",
  "career": "Kariyer yorumu",
  "money": "Para yorumu",
  "advice": "Tavsiye",
  "closing": "Kapanış cümlesi"
}
          `.trim(),
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Bu kahve fincanı fotoğrafını premium şekilde yorumla.",
            },
            {
              type: "image_url",
              image_url: {
                url: `data:image/jpeg;base64,${base64Image}`,
              },
            },
          ],
        },
      ],
    });

    const raw = response.choices?.[0]?.message?.content || "{}";
    const parsed = JSON.parse(raw);

    res.json({
      success: true,
      result: parsed,
    });
  } catch (e) {
    const errorText = String(e);

    if (errorText.includes("DAILY_LIMIT")) {
      return res.status(429).json({ error: "Günlük AI limitine ulaştın." });
    }

    if (errorText.includes("NO_COIN")) {
      return res.status(402).json({ error: "Coin yetersiz." });
    }

    if (errorText.includes("USER_NOT_FOUND")) {
      return res.status(404).json({ error: "Kullanıcı bulunamadı." });
    }

    if (errorText.includes("429")) {
      return res.status(429).json({
        error: "OpenAI limiti doldu veya çok sık istek atıldı. Biraz bekleyip tekrar dene.",
      });
    }

    console.error("COFFEE ERROR:", e);
    return res.status(500).json({
      error: "Kahve falı çalışmadı",
      detail: errorText,
    });
  } finally {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("🚀 Server running on port", PORT);
});