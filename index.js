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

function cleanTextForMemory(value, maxLen = 260) {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .trim();

  if (!text) return "";
  return text.slice(0, maxLen);
}

function chunkText(value, maxLen = 900) {
  const text = String(value || "").trim();
  if (!text) return "";
  return text.slice(0, maxLen);
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

    if (!snap.exists) {
      tx.set(ref, {
        coin: 100,
        premiumCoin: 0,
        premium: false,
        dailyUsage: 0,
        lastUsageDate: "",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      snap = await tx.get(ref);
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

    if (!premium && coin < cost) {
      throw new Error("NO_COIN");
    }

    const newCoin = premium ? coin : coin - cost;

    tx.update(ref, {
      coin: newCoin,
      ...(premium
        ? {}
        : {
            dailyUsage: dailyUsage + 1,
            lastUsageDate: today,
          }),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    if (!premium) {
      const historyRef = ref.collection("coin_history").doc();
      tx.set(historyRef, {
        type: "spend",
        amount: -cost,
        balanceAfter: newCoin,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        meta: { reason },
      });
    }

    return true;
  });
}

async function getUserProfile(uid) {
  const userRef = db.collection("users").doc(uid);
  const userSnap = await userRef.get();

  if (!userSnap.exists) {
    return {
      premium: false,
      memoryText: "",
      memoryCount: 0,
      profileSummary: "",
    };
  }

  const userData = userSnap.data() || {};
  const premium = Boolean(userData.premium || false);

  const readingsSnap = await userRef
    .collection("readings")
    .orderBy("createdAt", "desc")
    .limit(7)
    .get();

  if (readingsSnap.empty) {
    return {
      premium,
      memoryText: "",
      memoryCount: 0,
      profileSummary: "",
    };
  }

  const memoryItems = [];
  const compactReadings = [];

  for (const doc of readingsSnap.docs) {
    const data = doc.data() || {};
    const type = String(data.type || "reading").trim();
    const result = cleanTextForMemory(data.result, 260);

    if (!result) continue;

    memoryItems.push(`[${type}] ${result}`);
    compactReadings.push(`${type.toUpperCase()}: ${chunkText(result, 550)}`);
  }

  let profileSummary = "";

  if (premium && compactReadings.length > 0) {
    try {
      const profileResponse = await createWithRetry({
        model: "gpt-4.1-mini",
        temperature: 0.6,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: `
Aşağıdaki fal geçmişlerinden kullanıcı hakkında kısa bir sezgisel profil çıkar.

Sadece JSON döndür:
{
  "emotionalTone": "kısa ifade",
  "lovePattern": "kısa ifade",
  "careerPattern": "kısa ifade",
  "moneyPattern": "kısa ifade",
  "innerNeed": "kısa ifade",
  "summary": "2-3 cümlelik genel kişilik/enerji özeti"
}

Kurallar:
- Teknik dil kullanma.
- Kesin hüküm verme.
- Yumuşak ve sezgisel çıkarımlar yap.
- Çok kısa tut.
            `.trim(),
          },
          {
            role: "user",
            content: compactReadings.join("\n---\n"),
          },
        ],
      });

      const raw = profileResponse.choices?.[0]?.message?.content || "{}";
      const parsed = JSON.parse(raw);

      const emotionalTone = cleanTextForMemory(parsed.emotionalTone, 100);
      const lovePattern = cleanTextForMemory(parsed.lovePattern, 100);
      const careerPattern = cleanTextForMemory(parsed.careerPattern, 100);
      const moneyPattern = cleanTextForMemory(parsed.moneyPattern, 100);
      const innerNeed = cleanTextForMemory(parsed.innerNeed, 100);
      const summary = cleanTextForMemory(parsed.summary, 320);

      profileSummary = [
        emotionalTone ? `Duygusal ton: ${emotionalTone}` : "",
        lovePattern ? `Aşk eğilimi: ${lovePattern}` : "",
        careerPattern ? `Kariyer eğilimi: ${careerPattern}` : "",
        moneyPattern ? `Para eğilimi: ${moneyPattern}` : "",
        innerNeed ? `İç ihtiyaç: ${innerNeed}` : "",
        summary ? `Genel sezgi: ${summary}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    } catch (e) {
      console.error("PROFILE SUMMARY ERROR:", e);
      profileSummary = "";
    }
  }

  return {
    premium,
    memoryText: memoryItems.join("\n---\n"),
    memoryCount: memoryItems.length,
    profileSummary,
  };
}

function buildTarotSystemPrompt({
  cleanName,
  isPremium,
  memoryText,
  memoryCount,
  profileSummary,
}) {
  if (!isPremium) {
    return `
Sen Falix uygulamasının tarot yorumcususun.

Kurallar:
- Türkçe yaz.
- İlk satır doğal şekilde "Merhaba ${cleanName}," diye başlasın.
- Yorum zarif, profesyonel, mistik ve akıcı olsun.
- Korkutucu, felaket odaklı veya kesin hüküm veren dil kullanma.
- Kart isimlerini doğal şekilde yorumun içine yedir.
- Emoji kullanma.
- Gereksiz tekrar yapma.
- 220-320 kelime civarı tut.
- Metin AI yazmış gibi değil, doğal bir yorumcu diliyle aksın.
    `.trim();
  }

  return `
Sen Falix uygulamasının kişisel premium tarot yorumcususun.

Bu kullanıcıyı daha önce yorumladın.
Onu tamamen ezberlemiş gibi değil, ama enerjisini zaman içinde tanımış sezgisel bir yorumcu gibi yaklaş.

Kullanıcının yakın geçmişteki fal hafızası (${memoryCount} kayıt):
${memoryText || "Henüz kayıt yok."}

Kullanıcı profiline dair sezgisel özet:
${profileSummary || "Henüz profil özeti yok."}

Kurallar:
- Türkçe yaz.
- İlk satır doğal şekilde "Merhaba ${cleanName}," diye başlasın.
- AI, sistem, model, analiz motoru gibi görünme.
- Doğal, sıcak, sezgisel, zarif ve kişisel yaz.
- Uygun yerlerde geçmişten gelen benzer enerjilere hafifçe değinebilirsin.
- Teknik ifade kullanma.
- "Verilerine göre", "geçmiş kayıtlarına göre" gibi laflar kullanma.
- Kullanıcı kendini görülmüş ve anlaşılmış hissetsin.
- Kart isimlerini doğal şekilde yorumun içine yedir.
- Korkutucu, sert veya kesin hüküm veren dil kullanma.
- Klişe tekrar yapma.
- 240-360 kelime aralığında tut.
  `.trim();
}

function buildCoffeeSystemPrompt({
  cleanName,
  isPremium,
  memoryText,
  memoryCount,
  profileSummary,
}) {
  if (!isPremium) {
    return `
Sen Falix uygulamasının kahve falı yorumcususun.

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

Kurallar:
- Metin doğal olsun.
- AI gibi görünmesin.
- Korkutucu veya kesin hüküm veren dil kullanma.
- Her alan dolu gelsin.
    `.trim();
  }

  return `
Sen Falix uygulamasının kişisel premium kahve falı yorumcususun.

Bu kullanıcı premium üye.
Önceki enerjilerini açık açık saymadan, onları zaman içinde hissetmiş bir yorumcu gibi yaz.

Kullanıcının yakın geçmişteki fal hafızası (${memoryCount} kayıt):
${memoryText || "Henüz kayıt yok."}

Kullanıcı profiline dair sezgisel özet:
${profileSummary || "Henüz profil özeti yok."}

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

Kurallar:
- AI gibi görünme.
- Doğal, sıcak, sezgisel ve kişisel yaz.
- Gerekirse geçmişten gelen tanıdık enerjilere hafifçe değin.
- Teknik ifade kullanma.
- Klişe tekrar yapma.
- Her alan dolu gelsin.
- Korkutucu, sert veya kesin hüküm veren dil kullanma.
    `.trim();
}

app.post("/tarot", authMiddleware, async (req, res) => {
  try {
    const { cards = [], topic = "genel", userName = "Güzel Ruh" } = req.body;
    const cleanName = safeUserName(userName);

    await checkUserAccess(req.uid, 80, "tarot_ai");

    const userProfile = await getUserProfile(req.uid);

    const response = await createWithRetry({
      model: "gpt-4.1-mini",
      temperature: userProfile.premium ? 0.95 : 0.9,
      messages: [
        {
          role: "system",
          content: buildTarotSystemPrompt({
            cleanName,
            isPremium: userProfile.premium,
            memoryText: userProfile.memoryText,
            memoryCount: userProfile.memoryCount,
            profileSummary: userProfile.profileSummary,
          }),
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
        error:
          "OpenAI limiti doldu veya çok sık istek atıldı. Biraz bekleyip tekrar dene.",
      });
    }

    console.error("TAROT ERROR:", e);
    return res.status(500).json({
      error: "Tarot çalışmadı",
      detail: errorText,
    });
  }
});

app.post(
  "/coffee-vision",
  authMiddleware,
  upload.single("image"),
  async (req, res) => {
    const filePath = req.file?.path;

    try {
      if (!filePath) {
        return res.status(400).json({ error: "Foto yok" });
      }

      const cleanName = safeUserName(req.body?.userName);
      await checkUserAccess(req.uid, 120, "coffee_ai");

      const userProfile = await getUserProfile(req.uid);
      const base64Image = fs.readFileSync(filePath, { encoding: "base64" });

      const response = await createWithRetry({
        model: "gpt-4.1-mini",
        response_format: { type: "json_object" },
        temperature: userProfile.premium ? 0.95 : 0.9,
        messages: [
          {
            role: "system",
            content: buildCoffeeSystemPrompt({
              cleanName,
              isPremium: userProfile.premium,
              memoryText: userProfile.memoryText,
              memoryCount: userProfile.memoryCount,
              profileSummary: userProfile.profileSummary,
            }),
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Bu kahve fincanı fotoğrafını yorumla. Fincandaki şekilleri sezgisel, doğal ve akıcı biçimde ele al.",
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
          error:
            "OpenAI limiti doldu veya çok sık istek atıldı. Biraz bekleyip tekrar dene.",
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
  }
);

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("🚀 Server running on port", PORT);
});