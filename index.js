const express = require('express');
const { google } = require('googleapis');

const app = express();
app.use(express.json());

const auth = new google.auth.GoogleAuth({
  keyFile: 'service-account.json',
  scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
});

app.post('/gsc-data', async (req, res) => {
  try {
    const authClient = await auth.getClient();
    const searchconsole = google.searchconsole({ version: 'v1', auth: authClient });

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
    res.status(500).send(error.toString());
  }
});

app.listen(3000, () => {
  console.log('API çalışıyor: http://localhost:3000');
});