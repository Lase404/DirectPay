const express = require('express');
const cors = require('cors');
const { sellScene } = require('./sellScene'); // Adjust path as needed

const app = express();
app.use(express.json());
app.use(cors({ origin: process.env.FRONTEND_URL || 'https://directpay.onrender.com' }));

// Webhook to handle sell completion
app.post('/webhook/sell-completed', async (req, res) => {
  const { sessionId, txHash } = req.body;
  const logger = sellScene.logger;
  const db = sellScene.db;

  if (!sessionId || !txHash) {
    logger.error(`Webhook error: Missing sessionId or txHash`);
    return res.status(400).send('Missing sessionId or txHash');
  }

  try {
    const sessionRef = db.collection('sessions').doc(sessionId);
    const sessionDoc = await sessionRef.get();

    if (!sessionDoc.exists) {
      logger.error(`Webhook error: Session ${sessionId} not found`);
      return res.status(404).send('Session not found');
    }

    await sessionRef.update({
      status: 'completed',
      txHash,
      updatedAt: new Date().toISOString(),
    });

    logger.info(`Webhook: Session ${sessionId} marked as completed with txHash ${txHash}`);
    res.status(200).send('Success');
  } catch (error) {
    logger.error(`Webhook error for session ${sessionId}: ${error.message}`);
    res.status(500).send('Error');
  }
});

// API to retrieve session data
app.get('/api/session', async (req, res) => {
  const { sessionId } = req.query;
  const logger = sellScene.logger;
  const db = sellScene.db;

  if (!sessionId) {
    logger.error(`API error: Missing sessionId`);
    return res.status(400).send('Missing sessionId');
  }

  try {
    const sessionRef = db.collection('sessions').doc(sessionId);
    const sessionDoc = await sessionRef.get();

    if (!sessionDoc.exists) {
      logger.error(`API error: Session ${sessionId} not found`);
      return res.status(404).send('Session not found');
    }

    const sessionData = sessionDoc.data();
    logger.info(`API: Retrieved session ${sessionId}`);
    res.json(sessionData);
  } catch (error) {
    logger.error(`API error for session ${sessionId}: ${error.message}`);
    res.status(500).send('Error');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Webhook server running on port ${PORT}`);
});
