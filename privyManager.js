const { PrivyClient } = require('@privy-io/server-auth');
const admin = require('firebase-admin');
const logger = require('./logger');

class PrivyManager {
  constructor() {
    this.client = new PrivyClient(
      process.env.PRIVY_APP_ID,
      process.env.PRIVY_APP_SECRET
    );
  }

  // Verify a user's access token and return their wallet address
  async verifyUserToken(token) {
    try {
      const verifiedClaims = await this.client.verifyAuthToken(token);
      const userId = verifiedClaims.userId; // Privy DID
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
