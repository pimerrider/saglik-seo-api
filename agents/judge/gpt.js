const OpenAI = require("openai");

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * GPT, Gemini'nin taslağını değerlendirir. Çelişki/eksik bulur,
 * eksik veri varsa kullanıcıdan ister, yoksa tatmin olup olmadığına karar verir.
 * @param {string} mode
 * @param {string} topic
 * @param {string} draft - Gemini'nin ürettiği taslak
 * @param {number} round - Kaçıncı tur (1-4)
 * @param {boolean} forceFinal - 4. turda zorla final üret
 * @returns {Promise<{satisfied: boolean, feedback: string|null, missingFields: string[], finalOutput: string|null}>}
 */
async function judge(mode, topic, draft, round, forceFinal = false) {
  const systemPrompt = `
Sen sıkı bir editör/hakemsin. Gemini'nin ürettiği taslağı değerlendiriyorsun.
Görev tipi: ${mode}
Konu: ${topic}

Değerlendirme kriterleri:
- Çelişki var mı?
- Eksik/zayıf nokta var mı?
- SEO/başlık/yapı açısından (ilgiliyse) optimize mi?
- Kullanıcıdan gelmesi gereken ama eksik olan bir veri var mı (örn: hedef kelime, mevcut GSC verisi, kullanıcının kendi görseli)?

${forceFinal ? "BU SON TUR. Ne olursa olsun satisfied=true ver ve elindeki en iyi haliyle finalOutput üret." : ""}

SADECE şu JSON formatında cevap ver, başka hiçbir şey yazma:
{
  "satisfied": boolean,
  "feedback": "eksik/çelişki varsa Gemini'ye düzeltme talimatı, yoksa null",
  "missingFields": ["kullanıcıdan istenmesi gereken veri varsa liste, yoksa boş dizi"],
  "finalOutput": "satisfied=true ise nihai, temiz çıktı; değilse null"
}
`.trim();

  const completion = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL || "gpt-4.1",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: `Taslak (tur ${round}):\n\n${draft}` },
    ],
    response_format: { type: "json_object" },
  });

  const raw = completion.choices[0].message.content;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    // Parse hatasında güvenli fallback - final'e zorla
    parsed = { satisfied: true, feedback: null, missingFields: [], finalOutput: draft };
  }

  return parsed;
}

module.exports = { judge };
