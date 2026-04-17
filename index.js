const express = require('express');
const { google } = require('googleapis');

const app = express();
app.use(express.json());

// ✅ DOĞRU AUTH (ENV İLE)
const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
  scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
});

app.post('/gsc-data', async (req, res) => {
  try {
    const authClient = await auth.getClient();
    const searchconsole = google.searchconsole({
      version: 'v1',
      auth: authClient
    });

    const response = await searchconsole.searchanalytics.query({
      siteUrl: req.body.siteUrl,
      requestBody: {
        startDate: req.body.startDate,
        endDate: req.body.endDate,
        dimensions: ['query'],
        rowLimit: 20
      }
    });

    res.json(response.data);
  } catch (error) {
    console.error(error);
    res.status(500).send(error.toString());
  }
});

// ✅ PORT DÜZELTME (Render için)
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`API çalışıyor: ${PORT}`);
});
