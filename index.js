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

const STANDARD_DAILY_TAROT_LIMIT = 1;
const STANDARD_DAILY_COFFEE_LIMIT = 1;
const STANDARD_DAILY_AI_LIMIT = STANDARD_DAILY_TAROT_LIMIT + STANDARD_DAILY_COFFEE_LIMIT;

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


function dailyLimitConfig(reason) {
  if (reason === "tarot_ai") {
    return {
      field: "tarotDailyUsage",
      lastField: "lastTarotUsageDate",
      limit: STANDARD_DAILY_TAROT_LIMIT,
      code: "DAILY_TAROT_LIMIT",
    };
  }

  if (reason === "coffee_ai") {
    return {
      field: "coffeeDailyUsage",
      lastField: "lastCoffeeUsageDate",
      limit: STANDARD_DAILY_COFFEE_LIMIT,
      code: "DAILY_COFFEE_LIMIT",
    };
  }

  return null;
}

async function checkUserAccess(uid, cost, reason, freeRightField = null) {
  const ref = db.collection("users").doc(uid);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const defaultUserData = {
      coin: 100,
      premiumCoin: 0,
      premium: false,
      dailyUsage: 0,
      lastUsageDate: "",
      tarotDailyUsage: 0,
      lastTarotUsageDate: "",
      coffeeDailyUsage: 0,
      lastCoffeeUsageDate: "",
      freeTarotCount: 0,
      freeCoffeeCount: 0,
      expertMessageCount: 0,
      adFreeCount: 0,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (!snap.exists) {
      tx.set(ref, defaultUserData);
    }

    const data = snap.exists ? snap.data() || {} : defaultUserData;
    const today = getTodayKey();

    const typeLimit = dailyLimitConfig(reason);
    let typeUsage = 0;

    if (!Boolean(data.premium || false) && typeLimit) {
      const lastTypeUsageDate = String(data[typeLimit.lastField] || "");
      typeUsage = lastTypeUsageDate === today ? Number(data[typeLimit.field] || 0) : 0;

      if (typeUsage >= typeLimit.limit) {
        throw new Error(typeLimit.code);
      }
    }

    if (freeRightField) {
      const freeRightCount = Number(data[freeRightField] || 0);

      if (freeRightCount > 0) {
        const newFreeRightCount = freeRightCount - 1;

        tx.update(ref, {
          [freeRightField]: newFreeRightCount,
          ...(typeLimit
            ? {
                [typeLimit.field]: typeUsage + 1,
                [typeLimit.lastField]: today,
              }
            : {}),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        const historyRef = ref.collection("free_right_history").doc();
        tx.set(historyRef, {
          type: "free_right_used",
          field: freeRightField,
          amount: -1,
          balanceAfter: newFreeRightCount,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          meta: { reason },
        });

        return {
          ok: true,
          usedFreeRight: true,
          freeRightField,
        };
      }
    }

    let coin = Number(data.coin || 0);
    const premium = Boolean(data.premium || false);
    let dailyUsage = Number(data.dailyUsage || 0);
    const lastUsageDate = String(data.lastUsageDate || "");

    if (!premium && lastUsageDate !== today) {
      dailyUsage = 0;
    }

    if (!premium && dailyUsage >= STANDARD_DAILY_AI_LIMIT) {
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
            ...(typeLimit
              ? {
                  [typeLimit.field]: typeUsage + 1,
                  [typeLimit.lastField]: today,
                }
              : {}),
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

    return {
      ok: true,
      usedFreeRight: false,
    };
  });
}

async function spendPremiumCoin(uid, amount, reason, meta = {}) {
  const ref = db.collection("users").doc(uid);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) {
      throw new Error("USER_NOT_FOUND");
    }

    const data = snap.data() || {};
    const currentPremiumCoin = Number(data.premiumCoin || 0);

    if (currentPremiumCoin < amount) {
      throw new Error("NO_PREMIUM_COIN");
    }

    const newPremiumCoin = currentPremiumCoin - amount;

    tx.update(ref, {
      premiumCoin: newPremiumCoin,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    const historyRef = ref.collection("premium_coin_history").doc();
    tx.set(historyRef, {
      type: "spend",
      amount: -amount,
      balanceAfter: newPremiumCoin,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      meta: { reason, ...meta },
    });

    return { ok: true, balanceAfter: newPremiumCoin };
  });
}

async function saveAiReading(uid, type, result, extra = {}) {
  const userRef = db.collection("users").doc(uid);
  await userRef.collection("readings").add({
    type,
    result: cleanTextForMemory(result, 2200),
    ...extra,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

function monetizationErrorResponse(res, e, label = "İşlem") {
  const errorText = String(e);

  if (errorText.includes("NO_PREMIUM_COIN")) {
    return res.status(402).json({
      error: "Premium Coin yetersiz. Devam etmek için Premium Coin paketi alabilirsin.",
    });
  }

  if (errorText.includes("NO_COIN")) {
    return res.status(402).json({ error: "Coin yetersiz." });
  }

  if (errorText.includes("DAILY_LIMIT")) {
    return res.status(429).json({
      error: "Günlük AI limitine ulaştın. Premium ile sınırsız devam edebilirsin.",
    });
  }

  if (errorText.includes("USER_NOT_FOUND")) {
    return res.status(404).json({ error: "Kullanıcı bulunamadı." });
  }

  if (errorText.includes("429")) {
    return res.status(429).json({
      error: "AI yoğunluğu var. Biraz sonra tekrar dene.",
    });
  }

  console.error(`${label.toUpperCase()} ERROR:`, e);
  return res.status(500).json({ error: `${label} çalışmadı`, detail: errorText });
}

async function consumeFreeRight(uid, fieldName, historyCollection, historyType) {
  const ref = db.collection("users").doc(uid);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) {
      throw new Error("USER_NOT_FOUND");
    }

    const data = snap.data() || {};
    const current = Number(data[fieldName] || 0);

    if (current <= 0) {
      throw new Error("NO_FREE_RIGHT");
    }

    const newValue = current - 1;

    tx.set(
      ref,
      {
        [fieldName]: newValue,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    const historyRef = ref.collection(historyCollection).doc();
    tx.set(historyRef, {
      type: historyType,
      amount: -1,
      balanceAfter: newValue,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

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
      identityText: "",
    };
  }

  const userData = userSnap.data() || {};
  const premium = Boolean(userData.premium || false);

  const name = safeUserName(userData.name || "");
  const motherName = safeUserName(userData.motherName || "");
  const birthYear = userData.birthYear ? String(userData.birthYear) : "";
  const motherBirthYear = userData.motherBirthYear
    ? String(userData.motherBirthYear)
    : "";
  const relationshipStatus = String(userData.relationshipStatus || "").trim();

  const identityParts = [
    name ? `Ad: ${name}` : "",
    motherName ? `Anne adı: ${motherName}` : "",
    birthYear ? `Doğum yılı: ${birthYear}` : "",
    motherBirthYear ? `Anne doğum yılı: ${motherBirthYear}` : "",
    relationshipStatus ? `İlişki durumu: ${relationshipStatus}` : "",
  ].filter(Boolean);

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
      identityText: identityParts.join("\n"),
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
    identityText: identityParts.join("\n"),
  };
}


function buildRelationshipAndSalesPrompt(partnerInfo, readingType) {
  const cleanPartnerInfo = String(partnerInfo || "").trim().slice(0, 900);

  const partnerBlock = cleanPartnerInfo
    ? `
İlişki yaşadığı kişi bilgileri:
${cleanPartnerInfo}

Bu bilgileri özellikle aşk, bağ, niyet, duygusal mesafe ve ilişki enerjisi yorumlarında doğal şekilde dikkate al.
Bilgileri liste gibi tekrar etme; yoruma sezgisel biçimde yedir.
`
    : `
Kullanıcı ilişki yaşadığı kişinin bilgilerini girmemiş.
Eğer yorum aşk, ilişki, bağ veya karşı tarafın niyetiyle ilgili bir noktaya gelirse kısa ve doğal şekilde şunu hissettir:
Profiline o kişinin adını, anne adını ve doğum tarihini eklerse sonraki ${readingType} yorumu daha kişisel ve net açılabilir.
Bunu baskıcı şekilde değil, öneri gibi söyle.
`;

  const salesBlock = `
Yorumun sonunda, sadece doğal akış uygunsa, gerçek uzman desteğine yumuşak bir kapı aç.
Kesin satış dili kullanma. Şu hissi ver:
Bu durum yüzeyde göründüğünden daha derin olabilir; gerçek uzmanla daha detaylı açılım yapılabilir.
Kullanıcıyı korkutma, çaresiz hissettirme veya kesin sonuç vaat etme.
`;

  return `${partnerBlock}
${salesBlock}`.trim();
}

function buildTarotSystemPrompt({
  cleanName,
  isPremium,
  memoryText,
  memoryCount,
  profileSummary,
  identityText,
}) {
  if (!isPremium) {
    return `
Sen Falix uygulamasının tarot yorumcususun.

Kurallar:
- Türkçe yaz.
- İlk satır doğal şekilde "Merhaba ${cleanName}," diye başlasın.
- Bu bir TAROT yorumudur.
- Kahve falı, fincan, telve, köpük, şekil gibi ifadeleri ASLA kullanma.
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

Kullanıcıya dair bilgiler:
${identityText || "Ek profil bilgisi yok."}

Kullanıcının yakın geçmişteki fal hafızası (${memoryCount} kayıt):
${memoryText || "Henüz kayıt yok."}

Kullanıcı profiline dair sezgisel özet:
${profileSummary || "Henüz profil özeti yok."}

Kurallar:
- Türkçe yaz.
- İlk satır doğal şekilde "Merhaba ${cleanName}," diye başlasın.
- Bu bir TAROT yorumudur.
- Kahve falı ile ilgili hiçbir şey söyleme.
- "fincan", "telve", "kahve", "şekil gördüm" gibi ifadeler kullanma.
- AI, sistem, model, analiz motoru gibi görünme.
- Doğal, sıcak, sezgisel, zarif ve kişisel yaz.
- Uygun yerlerde geçmişten gelen benzer enerjilere hafifçe değinebilirsin.
- Kullanıcı bilgilerini kaba şekilde listeleme, doğal yedir.
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
  identityText,
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

Kullanıcıya dair bilgiler:
${identityText || "Ek profil bilgisi yok."}

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
- Kullanıcı bilgilerini doğal hissettir, göze sokma.
- Teknik ifade kullanma.
- Klişe tekrar yapma.
- Her alan dolu gelsin.
- Korkutucu, sert veya kesin hüküm veren dil kullanma.
    `.trim();
}

app.post("/tarot", authMiddleware, async (req, res) => {
  try {
const {
      cards = [],
      topic = "genel",
      userName = "Güzel Ruh",
      partnerInfo = "",
      useFreeTarot = false,
    } = req.body;
    const cleanName = safeUserName(userName);

    await checkUserAccess(
      req.uid,
      80,
      "tarot_ai",
      String(useFreeTarot) === "true" ? "freeTarotCount" : null
    );

    const userProfile = await getUserProfile(req.uid);

    const response = await createWithRetry({
      model: "gpt-4.1-mini",
      temperature: userProfile.premium ? 0.95 : 0.9,
      messages: [
        {
          role: "system",
          content:
            buildTarotSystemPrompt({
              cleanName,
              isPremium: userProfile.premium,
              memoryText: userProfile.memoryText,
              memoryCount: userProfile.memoryCount,
              profileSummary: userProfile.profileSummary,
              identityText: userProfile.identityText,
            }) +
            "\n\n" +
            buildRelationshipAndSalesPrompt(partnerInfo, "tarot"),
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

    if (errorText.includes("DAILY_TAROT_LIMIT")) {
      return res.status(429).json({
        error: "Bugünkü ücretsiz Tarot limitin doldu. Devam etmek için Premium'a geç veya Premium Coin al.",
      });
    }

    if (errorText.includes("DAILY_COFFEE_LIMIT")) {
      return res.status(429).json({
        error: "Bugünkü ücretsiz Kahve limitin doldu. Devam etmek için Premium'a geç veya Premium Coin al.",
      });
    }

    if (errorText.includes("DAILY_LIMIT")) {
      return res.status(429).json({ error: "Günlük AI limitine ulaştın. Premium ile sınırsız devam edebilirsin." });
    }

    if (errorText.includes("NO_FREE_RIGHT")) {
      return res.status(402).json({ error: "Ücretsiz hakkın bulunamadı." });
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
      const useFreeCoffee =
        String(req.body?.useFreeCoffee || "false") === "true";

      await checkUserAccess(
        req.uid,
        120,
        "coffee_ai",
        String(useFreeCoffee) === "true"
          ? "freeCoffeeCount"
          : null
      );
const partnerInfo = req.body?.partnerInfo || "";
      

      const userProfile = await getUserProfile(req.uid);
      const base64Image = fs.readFileSync(filePath, { encoding: "base64" });
            // GÖRSEL KAHVE FALI İÇİN UYGUN MU KONTROLÜ
      const validationResponse = await createWithRetry({
        model: "gpt-4.1-mini",
        response_format: { type: "json_object" },
        temperature: 0,
        messages: [
          {
            role: "system",
            content: `
Sen bir görsel doğrulama sistemisin.

Görev:
Kullanıcının gönderdiği görsel gerçekten kahve falı için uygun mu kontrol et.

SADECE şu durumlarda true ver:
- Türk kahvesi fincanı
- Kahve telvesi
- Kahve falı tabağı
- Fincan içindeki telve izleri

Şu durumlarda false ver:
- İnsan fotoğrafı
- Selfie
- Manzara
- Hayvan
- Rastgele obje
- Boş görsel
- Yazı ekran görüntüsü
- Tarot kartı
- Başka herhangi bir şey

Sadece JSON döndür:

{
  "isCoffeeCup": true
}

veya

{
  "isCoffeeCup": false
}
            `.trim(),
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Bu görsel kahve falı için uygun mu?",
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

      const validationRaw =
        validationResponse.choices?.[0]?.message?.content || "{}";

      const validationParsed = JSON.parse(validationRaw);

      if (!validationParsed.isCoffeeCup) {
        return res.status(400).json({
          error:
            "Bu görsel kahve falı için uygun değil. Lütfen kahve fincanı veya telve görseli yükleyin.",
        });
      }

      const response = await createWithRetry({
        model: "gpt-4.1-mini",
        response_format: { type: "json_object" },
        temperature: userProfile.premium ? 0.95 : 0.9,
        messages: [
          {
            role: "system",
            content:
              buildCoffeeSystemPrompt({
                cleanName,
                isPremium: userProfile.premium,
                memoryText: userProfile.memoryText,
                memoryCount: userProfile.memoryCount,
                profileSummary: userProfile.profileSummary,
                identityText: userProfile.identityText,
              }) +
              "\n\n" +
              buildRelationshipAndSalesPrompt(partnerInfo, "kahve"),
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

      if (errorText.includes("DAILY_TAROT_LIMIT")) {
        return res.status(429).json({
          error: "Bugünkü ücretsiz Tarot limitin doldu. Devam etmek için Premium'a geç veya Premium Coin al.",
        });
      }

      if (errorText.includes("DAILY_COFFEE_LIMIT")) {
        return res.status(429).json({
          error: "Bugünkü ücretsiz Kahve limitin doldu. Devam etmek için Premium'a geç veya Premium Coin al.",
        });
      }

      if (errorText.includes("DAILY_LIMIT")) {
        return res.status(429).json({ error: "Günlük AI limitine ulaştın. Premium ile sınırsız devam edebilirsin." });
      }

      if (errorText.includes("NO_FREE_RIGHT")) {
        return res.status(402).json({ error: "Ücretsiz hakkın bulunamadı." });
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


app.post("/kahin/ask", authMiddleware, async (req, res) => {
  try {
    const question = String(req.body?.question || "").trim().slice(0, 900);
    const cleanName = safeUserName(req.body?.userName);

    if (question.length < 4) {
      return res.status(400).json({ error: "Lütfen daha net bir soru yaz." });
    }

    await spendPremiumCoin(req.uid, 50, "kahin_ai_question", { questionPreview: question.slice(0, 120) });
    const userProfile = await getUserProfile(req.uid);

    const response = await createWithRetry({
      model: "gpt-4.1-mini",
      temperature: 0.88,
      messages: [
        {
          role: "system",
          content: `
Sen Falix uygulamasının AI Kahin yorumcususun.

Görev:
- Kullanıcının sorduğu soruya sezgisel, sıcak, kişisel ve akıcı cevap ver.
- Kesin gelecek vaadi, tıbbi/hukuki/finansal kesin tavsiye verme.
- Korkutma, bağımlılık yaratma, çaresiz hissettirme.
- Aşk, ilişki, para ve kariyer konularında yumuşak ve umut veren ama dengeli konuş.
- Premium Coin harcanan özel cevap olduğu için cevap dolu ve değerli hissettirsin.
- En sonda tek cümleyle gerçek uzman alanına doğal yönlendir: "İstersen bunu gerçek uzman yorumuyla daha derin açtırabilirsin." gibi.

Kullanıcı adı: ${cleanName}
Kullanıcı kimlik/profil bilgileri:
${userProfile.identityText || "Yok"}

Premium geçmiş hafızası:
${userProfile.profileSummary || userProfile.memoryText || "Henüz yeterli geçmiş yok"}
          `.trim(),
        },
        { role: "user", content: question },
      ],
    });

    const answer = response.choices?.[0]?.message?.content || "Kahin cevabı alınamadı.";

    const chatRef = db.collection("users").doc(req.uid).collection("kahin_chats").doc();
    await chatRef.set({
      question,
      answer,
      cost: 50,
      currency: "premiumCoin",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    await saveAiReading(req.uid, "kahin", answer, { question });

    return res.json({ success: true, answer, cost: 50 });
  } catch (e) {
    return monetizationErrorResponse(res, e, "Kahin");
  }
});

app.post("/dream/interpret", authMiddleware, async (req, res) => {
  try {
    const dream = String(req.body?.dream || "").trim().slice(0, 1600);
    const cleanName = safeUserName(req.body?.userName);

    if (dream.length < 10) {
      return res.status(400).json({ error: "Rüyanı biraz daha detaylı yaz." });
    }

    await checkUserAccess(req.uid, 50, "dream_ai");
    const userProfile = await getUserProfile(req.uid);

    const response = await createWithRetry({
      model: "gpt-4.1-mini",
      temperature: 0.9,
      messages: [
        {
          role: "system",
          content: `
Sen Falix rüya yorumcususun.
Rüyayı mistik, sezgisel ve psikolojik sembol diliyle yorumla.
Bölümler:
1) Rüyanın ana mesajı
2) Aşk/ilişki işareti
3) Para/kariyer işareti
4) Ruh hâli ve tavsiye
5) Kapanış
Kesin hüküm verme, korkutma, tıbbi/psikiyatrik teşhis koyma.
Kullanıcı: ${cleanName}
Profil:
${userProfile.identityText || "Yok"}
          `.trim(),
        },
        { role: "user", content: dream },
      ],
    });

    const result = response.choices?.[0]?.message?.content || "Rüya yorumu alınamadı.";
    await saveAiReading(req.uid, "dream", result, { dream: cleanTextForMemory(dream, 700) });
    return res.json({ success: true, result, cost: 50 });
  } catch (e) {
    return monetizationErrorResponse(res, e, "Rüya tabiri");
  }
});

app.post("/katina", authMiddleware, async (req, res) => {
  try {
    const spread = String(req.body?.spread || "ask_katinasi").trim();
    const cleanName = safeUserName(req.body?.userName);
    const spreadLabel = spread === "dokuz_kart" ? "9 Kart Katina" : spread === "bes_kart" ? "5 Kart Katina" : "Aşk Katinası";

    await checkUserAccess(req.uid, 120, "katina_ai");
    const userProfile = await getUserProfile(req.uid);

    const response = await createWithRetry({
      model: "gpt-4.1-mini",
      temperature: 0.92,
      messages: [
        {
          role: "system",
          content: `
Sen Falix Katina falı yorumcususun.
Açılım: ${spreadLabel}

Yorumu şu yapıda ver:
- Açılımın genel enerjisi
- Karşı tarafın niyeti/duygusal mesafesi
- Aradaki bağ ve engel
- Yakın dönem işaretleri
- Net tavsiye
- Gerçek uzman yorumu için yumuşak kapanış

Kesin hüküm verme, manipülatif konuşma, korkutma.
Kullanıcı: ${cleanName}
Profil/hafıza:
${userProfile.identityText || ""}
${userProfile.profileSummary || userProfile.memoryText || ""}
          `.trim(),
        },
        { role: "user", content: `${spreadLabel} açılımını yap.` },
      ],
    });

    const result = response.choices?.[0]?.message?.content || "Katina yorumu alınamadı.";
    await saveAiReading(req.uid, "katina", result, { spread });
    return res.json({ success: true, result, cost: 120 });
  } catch (e) {
    return monetizationErrorResponse(res, e, "Katina");
  }
});

app.post("/relationship/analyze", authMiddleware, async (req, res) => {
  try {
    const userName = safeUserName(req.body?.userName);
    const partnerName = safeUserName(req.body?.partnerName);
    const note = String(req.body?.note || "").trim().slice(0, 700);

    if (!userName || !partnerName) {
      return res.status(400).json({ error: "İki isim de gerekli." });
    }

    await spendPremiumCoin(req.uid, 100, "relationship_analysis", { partnerName });
    const userProfile = await getUserProfile(req.uid);

    const response = await createWithRetry({
      model: "gpt-4.1-mini",
      temperature: 0.86,
      messages: [
        {
          role: "system",
          content: `
Sen Falix ilişki uyumu yorumcususun.
Premium Coin harcanan özel analiz olduğu için cevap derin ve düzenli olsun.
Bölümler:
1) Uyum yüzdesi hissi (kesin matematik değil, "enerji olarak")
2) Güçlü bağlar
3) Zorlayan noktalar
4) Karşı tarafın olası enerjisi
5) Yakın dönem tavsiyesi
6) Uzman yorumu yönlendirmesi
Kesin sonuç, garanti, manipülasyon ve korkutma yok.
Kullanıcı profili:
${userProfile.identityText || "Yok"}
          `.trim(),
        },
        {
          role: "user",
          content: `Kullanıcı: ${userName}\nKarşı taraf: ${partnerName}\nNot: ${note || "Yok"}`,
        },
      ],
    });

    const result = response.choices?.[0]?.message?.content || "İlişki analizi alınamadı.";
    await saveAiReading(req.uid, "relationship", result, { partnerName, note: cleanTextForMemory(note, 500) });
    return res.json({ success: true, result, cost: 100 });
  } catch (e) {
    return monetizationErrorResponse(res, e, "İlişki analizi");
  }
});

app.post("/astrology/daily", authMiddleware, async (req, res) => {
  try {
    const sign = String(req.body?.sign || "Koç").trim().slice(0, 20);
    const cleanName = safeUserName(req.body?.userName);
    const today = getTodayKey();
    const docId = `${today}_${sign.toLowerCase().replace(/\s+/g, "_")}`;
    const cacheRef = db.collection("daily_horoscopes").doc(docId);
    const cached = await cacheRef.get();

    if (cached.exists && cached.data()?.result) {
      return res.json({ success: true, result: cached.data().result, cached: true });
    }

    const response = await createWithRetry({
      model: "gpt-4.1-mini",
      temperature: 0.82,
      messages: [
        {
          role: "system",
          content: `
Sen Falix günlük burç yorumcususun.
Burç: ${sign}
Tarih: ${today}
Kullanıcı hitabı: ${cleanName}

Kısa ama değerli yorum yaz:
- Genel enerji
- Aşk
- Para/kariyer
- Günün tavsiyesi
Kesin hüküm yok, korkutma yok.
          `.trim(),
        },
        { role: "user", content: `${sign} burcu için bugünün yorumunu üret.` },
      ],
    });

    const result = response.choices?.[0]?.message?.content || "Burç yorumu alınamadı.";
    await cacheRef.set({ sign, date: today, result, createdAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    return res.json({ success: true, result, cached: false });
  } catch (e) {
    return monetizationErrorResponse(res, e, "Günlük burç");
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("🚀 Server running on port", PORT);
});
