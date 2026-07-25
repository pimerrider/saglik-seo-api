const { GoogleGenerativeAI } = require("@google/generative-ai");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

/**
 * Gemini araştırma/taslak üretir.
 * @param {string} mode - 'article' | 'story' | 'cover-image' | 'seo'
 * @param {string} topic - Konu/başlık
 * @param {object} providedData - Kullanıcının sağladığı veriler (GSC verisi, kaynak, vs.)
 * @param {string|null} judgeFeedback - Önceki turdan GPT eleştirisi (varsa)
 * @returns {Promise<{draft: string, sourcesUsed: string[]}>}
 */
async function research(mode, topic, providedData = {}, judgeFeedback = null) {
  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-pro",
    // Not: grounding (googleSearch) ilk sürümde kapalı - kullanıcı zaten kaynak/veri besliyor.
    // İhtiyaç olursa: tools: [{ googleSearch: {} }] eklenir (ücretli tier gerektirir).
  });

  const taskInstructions = {
    "article": "Konuyla ilgili güncel, doğrulanmış kaynaklara dayanan bir makale taslağı yaz. Her iddiayı kaynakla destekle.",
    "story": "Verilen tema üzerine özgün bir masal taslağı yaz. Kaynak araştırması gerekmez, yaratıcı içerik üret.",
    "cover-image": "Konuya uygun, dikkat çekici bir kapak görseli için detaylı bir görsel üretim prompt'u hazırla (stil, kompozisyon, renk paleti dahil).",
    "seo": "Konuyla ilgili güncel SEO trendlerini, rakip içerikleri ve arama niyetini araştır, bulgularını özetle.",
  };

  const prompt = `
Görev: ${taskInstructions[mode] || taskInstructions["article"]}

Konu: ${topic}

Kullanıcının sağladığı veriler:
${JSON.stringify(providedData, null, 2)}

${judgeFeedback ? `\nÖnceki tur eleştirisi (bunu dikkate alarak düzelt):\n${judgeFeedback}\n` : ""}

Sadece taslağı/analizi ver, ek açıklama yapma.
`.trim();

  const result = await model.generateContent(prompt);
  const text = result.response.text();

  return { draft: text };
}

module.exports = { research };

