const { PrivyClient } = require('@privy-io/server-auth');
const admin = require('firebase-admin');
// =================== Initialize Logging ===================
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => `[${timestamp}] ${level.toUpperCase()}: ${message}`)
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'bot.log', maxsize: 5242880, maxFiles: 5 })
  ],
});

class PrivyManager {
  constructor() {
    this.client = new PrivyClient(
      process.env.PRIVY_APP_ID,
      process.env.PRIVY_APP_SECRET
    );
  }

  async verifyUserToken(token) {
    try {
      const verifiedClaims = await this.client.verifyAuthToken(token);
      const userId = verifiedClaims.userId;
      const walletAddress = verifiedClaims.linkedAccounts?.find(acc => acc.type === 'wallet')?.address;

      if (!walletAddress) {
        throw new Error('No wallet address found in user claims');
      }

      logger.info('Privy token verified', { userId, walletAddress });
      await this.logToBackend('Privy Token Verified', { userId, walletAddress });
      return { userId, walletAddress };
    } catch (error) {
      logger.error('Privy token verification failed:', error.message);
      await this.logToBackend('Privy Token Verification Failed', { error: error.message });
      throw error;
    }
  }

  async logToBackend(event, data) {
    try {
      await admin.firestore().collection('privy_logs').add({
        event,
        data,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
      });
    } catch (error) {
      logger.error('Failed to log Privy event to backend:', error.message);
    }
  }
}

module.exports = new PrivyManager();
