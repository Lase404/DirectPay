// =================== Imports ===================
const { Telegraf, Scenes, session, Markup } = require('telegraf');
const { WizardScene, Stage } = Scenes;
const admin = require('firebase-admin');
const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const crypto = require('crypto');
const Fuse = require('fuse.js');
const bcrypt = require('bcrypt');
const winston = require('winston');

// =================== Logger Setup ===================
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => `${timestamp} [${level.toUpperCase()}]: ${message}`)
  ),
  transports: [
    new winston.transports.File({ filename: 'bot.log' }),
    new winston.transports.Console()
  ],
});

// =================== Firebase Initialization ===================
const serviceAccountPath = path.join(__dirname, 'directpay.json'); // Ensure this file is secured on the server
if (!fs.existsSync(serviceAccountPath)) {
  logger.error('Firebase service account file (directpay.json) not found.');
  process.exit(1);
}
const serviceAccount = require(serviceAccountPath);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://directpay9ja.firebaseio.com"
});
const db = admin.firestore();

// =================== Environment Variables ===================
const {
  BOT_TOKEN,
  PAYCREST_API_KEY,
  PAYCREST_CLIENT_SECRET,
  PAYCREST_RATE_API_URL = 'https://api.paycrest.io/v1/rates',
  PAYCREST_RETURN_ADDRESS = "0x",
  PERSONAL_CHAT_ID,
  PAYSTACK_API_KEY,
  ADMIN_IDS = '',
  WEBHOOK_PATH = '/webhook/telegram',
  WEBHOOK_PAYCREST_PATH = '/webhook/paycrest',
  WEBHOOK_BLOCKRADAR_PATH = '/webhook/blockradar',
  WEBHOOK_DOMAIN,
  PORT = 4000,
  BLOCKRADAR_BASE_API_KEY,
  BLOCKRADAR_BNB_API_KEY,
  BLOCKRADAR_POLYGON_API_KEY,
  MAX_WALLETS = 5,
} = process.env;

// =================== Validations ===================
if (!BOT_TOKEN || !PAYCREST_API_KEY || !PAYCREST_CLIENT_SECRET || !WEBHOOK_DOMAIN || !PAYSTACK_API_KEY) {
  logger.error('Missing required environment variables. Please check your .env file.');
  process.exit(1);
}

// =================== Initialize Express App ===================
const app = express();

// =================== Initialize Telegraf Bot ===================
const bot = new Telegraf(BOT_TOKEN);

// =================== Set Webhook ===================
bot.telegram.setWebhook(`${WEBHOOK_DOMAIN}${WEBHOOK_PATH}`)
  .then(() => {
    logger.info(`Webhook set to ${WEBHOOK_DOMAIN}${WEBHOOK_PATH}`);
  })
  .catch((err) => {
    logger.error(`Failed to set webhook: ${err.message}`);
  });

// =================== Verify Webhook ===================
bot.telegram.getWebhookInfo()
  .then((info) => {
    logger.info(`Current webhook info: ${JSON.stringify(info, null, 2)}`);
  })
  .catch((err) => {
    logger.error(`Failed to get webhook info: ${err.message}`);
  });

// =================== Define Bank List ===================
const bankList = [
  { name: 'Access Bank', code: '044', aliases: ['access', 'access bank', 'accessb', 'access bank nigeria'], paycrestInstitutionCode: 'ABNGNGLA' },
  { name: 'GTBank', code: '058', aliases: ['gtbank', 'gt bank', 'gtb', 'gt bank nigeria'], paycrestInstitutionCode: 'GTBNGNGLA' },
  { name: 'Zenith Bank', code: '057', aliases: ['zenith', 'zenith bank', 'zenithb', 'zenith bank nigeria'], paycrestInstitutionCode: 'ZENNGLA' },
  { name: 'First Bank', code: '011', aliases: ['first bank', 'firstbank', 'first bank nigeria'], paycrestInstitutionCode: 'FBNGNGLA' },
  { name: 'UBA', code: '033', aliases: ['uba', 'united bank for africa', 'united bank africa'], paycrestInstitutionCode: 'UBANGNLAX' },
  { name: 'Polaris Bank', code: '076', aliases: ['polaris bank', 'polaris', 'polarisb', 'polaris bank nigeria'], paycrestInstitutionCode: 'PLANGNLAX' },
  { name: 'Ecobank', code: '050', aliases: ['ecobank', 'ecobank nigeria'], paycrestInstitutionCode: 'ECOBANGNLAX' },
  { name: 'Union Bank', code: '032', aliases: ['union bank', 'unionbank', 'union bank nigeria'], paycrestInstitutionCode: 'UNIONBANK' },
  { name: 'Heritage Bank', code: '030', aliases: ['heritage bank', 'heritagebank', 'heritage bank nigeria'], paycrestInstitutionCode: 'HTBANK' },
  { name: 'FCMB', code: '214', aliases: ['fcmb', 'first city monument bank', 'fcmb nigeria'], paycrestInstitutionCode: 'FCMBNGPC' },
];

// =================== Define Supported Chains ===================
const chains = {
  Base: {
    id: 'e31c44d6-0344-4ee1-bcd1-c88e89a9e3f1',
    key: BLOCKRADAR_BASE_API_KEY,
    apiUrl: 'https://api.blockradar.co/v1/wallets/e31c44d6-0344-4ee1-bcd1-c88e89a9e3f1/addresses',
    supportedAssets: ['USDC', 'USDT'],
    network: 'Base',
    assets: {
      USDC: 'a8aae94e-a2c3-424c-8db5-ea7415166ce3',
      USDT: 'a8aae94e-a2c3-424c-8db5-ea7415166ce3',
    }
  },
  Polygon: {
    id: '97d015af-9889-4ae0-9b99-0aa6ed5c69bd',
    key: BLOCKRADAR_POLYGON_API_KEY,
    apiUrl: 'https://api.blockradar.co/v1/wallets/97d015af-9889-4ae0-9b99-0aa6ed5c69bd/addresses',
    supportedAssets: ['USDC', 'USDT'],
    network: 'Polygon',
    assets: {
      USDC: 'a8aae94e-a2c3-424c-8db5-ea7415166ce3',
      USDT: 'a8aae94e-a2c3-424c-8db5-ea7415166ce3',
    }
  },
  'BNB Smart Chain': {
    id: 'f9bc72e5-1d44-4b7f-8b8c-a45f3a25a5c6',
    key: BLOCKRADAR_BNB_API_KEY,
    apiUrl: 'https://api.blockradar.co/v1/wallets/f9bc72e5-1d44-4b7f-8b8c-a45f3a25a5c6/addresses',
    supportedAssets: ['USDC', 'USDT'],
    network: 'BNB Smart Chain',
    assets: {
      USDC: 'a8aae94e-a2c3-424c-8db5-ea7415166ce3',
      USDT: 'a8aae94e-a2c3-424c-8db5-ea7415166ce3',
    }
  }
};

// =================== Chain Mapping ===================
const chainMapping = {
  'base': 'Base',
  'polygon': 'Polygon',
  'bnb smart chain': 'BNB Smart Chain',
  // Add other mappings if necessary
};

// =================== Initialize Fuse.js for Bank Matching ===================
const fuse = new Fuse(bankList, {
  keys: ['aliases'],
  threshold: 0.3, // Adjusted threshold for better matching
  includeScore: true
});

/**
 * Matches user input to a bank from the bankList with flexible matching.
 * @param {string} input - User input for bank name.
 * @returns {object|null} - Returns the matched bank object or null if not found.
 */
function matchBank(input) {
  const normalizedInput = input.trim().toLowerCase();

  // Check if input is purely numeric (likely an account number)
  if (/^\d+$/.test(normalizedInput)) {
    return null; // Invalid as a bank name
  }

  // First, try exact match on aliases
  const exactMatch = bankList.find(bank => bank.aliases.some(alias => alias.toLowerCase() === normalizedInput));
  if (exactMatch) return exactMatch;

  // If no exact match, use Fuse.js for fuzzy matching
  const result = fuse.search(normalizedInput);
  if (result.length > 0) {
    // You can adjust the criteria here based on score or return the best match
    return result[0].item;
  }

  return null;
}

// =================== Utility Functions ===================
/**
 * Updates user state in Firestore.
 * @param {string} userId - Telegram user ID.
 * @param {object} data - Data to update.
 */
async function updateUserState(userId, data) {
  const userRef = db.collection('users').doc(userId);
  await userRef.set(data, { merge: true });
}

/**
 * Retrieves user state from Firestore.
 * @param {string} userId - Telegram user ID.
 * @returns {object} - User state.
 */
async function getUserState(userId) {
  const userRef = db.collection('users').doc(userId);
  const doc = await userRef.get();
  if (!doc.exists) {
    // Initialize user state if not present
    await userRef.set({
      firstName: '',
      wallets: [],
      walletAddresses: []
    });
    return { firstName: '', wallets: [], walletAddresses: [] };
  }
  return doc.data();
}

/**
 * Generates a reference ID.
 * @returns {string} - Reference ID.
 */
function generateReferenceId() {
  return 'REF-' + crypto.randomBytes(6).toString('hex').toUpperCase();
}

/**
 * Generates a wallet address based on the selected chain.
 * Placeholder function; replace with actual wallet generation logic.
 * @param {string} chain - Chain name.
 * @returns {string} - Wallet address.
 */
async function generateWallet(chain) {
  // Placeholder: Replace with actual wallet generation logic
  // For demonstration, return a dummy address
  return '0x' + crypto.randomBytes(20).toString('hex');
}

/**
 * Maps asset and chain to Paycrest parameters.
 * Placeholder function; replace with actual mapping logic.
 * @param {string} asset - Asset symbol.
 * @param {string} chain - Chain name.
 * @returns {object|null} - Paycrest mapping or null if not found.
 */
function mapToPaycrest(asset, chain) {
  // Placeholder: Implement actual mapping based on Paycrest's API requirements
  return {
    asset,
    chain
    // Add other necessary parameters
  };
}

/**
 * Verifies Paycrest webhook signature.
 * @param {Buffer} requestBody - Raw request body.
 * @param {string} signatureHeader - Signature from headers.
 * @param {string} secretKey - Paycrest client secret.
 * @returns {boolean} - Verification result.
 */
function verifyPaycrestSignature(requestBody, signatureHeader, secretKey) {
  const hmac = crypto.createHmac('sha256', secretKey);
  hmac.update(requestBody);
  const calculatedSignature = hmac.digest('hex');

  try {
    return crypto.timingSafeEqual(Buffer.from(calculatedSignature), Buffer.from(signatureHeader));
  } catch (error) {
    // If buffer lengths are not equal, timingSafeEqual throws an error
    return false;
  }
}

/**
 * Calculates payout in NGN based on asset and amount.
 * Placeholder function; replace with actual calculation logic.
 * @param {string} asset - Asset symbol.
 * @param {number} amount - Amount in asset.
 * @returns {number} - Payout in NGN.
 */
function calculatePayout(asset, amount) {
  // Placeholder: Implement actual payout calculation based on exchange rates
  // For demonstration, assume a fixed rate
  const rate = 500; // Example rate: 1 USDC = ₦500
  return rate * amount;
}

/**
 * Calculates the amount earned in NGN based on asset and amount.
 * Placeholder function; replace with actual calculation logic.
 * @param {string} asset - Asset symbol.
 * @param {number} amount - Amount in asset.
 * @returns {number} - Amount earned in NGN.
 */
function calculateAmountEarnedInNaira(asset, amount) {
  // Placeholder: Implement actual calculation based on exchange rates
  const rate = 500; // Example rate: 1 USDC = ₦500
  return rate * amount;
}

/**
 * Verifies a bank account via Paycrest.
 * Placeholder function; replace with actual API integration.
 * @param {string} accountNumber - Bank account number.
 * @param {string} bankCode - Bank code.
 * @returns {object} - Verification result.
 */
async function verifyBankAccount(accountNumber, bankCode) {
  // Placeholder: Implement actual verification via Paycrest's API
  // For demonstration, return a mock response
  return {
    data: {
      account_name: 'John Doe'
    },
    status: 'success'
  };
}

/**
 * Creates a Paycrest order.
 * Placeholder function; replace with actual API integration.
 * @param {string} userId - Telegram user ID.
 * @param {number} amount - Amount in asset.
 * @param {string} asset - Asset symbol.
 * @param {string} chain - Chain name.
 * @param {object} bankDetails - User's bank details.
 * @param {string} returnAddress - Return address for Paycrest.
 * @returns {object} - Paycrest order details.
 */
async function createPaycrestOrder(userId, amount, asset, chain, bankDetails, returnAddress) {
  // Placeholder: Implement actual order creation via Paycrest's API
  // For demonstration, return a mock order
  return {
    id: generateReferenceId(),
    receiveAddress: '0x' + crypto.randomBytes(20).toString('hex')
  };
}

/**
 * Withdraws from Blockradar to Paycrest's receive address.
 * Placeholder function; replace with actual API integration.
 * @param {string} chain - Chain name.
 * @param {string} assetId - Asset ID in Blockradar.
 * @param {string} receiveAddress - Receive address from Paycrest.
 * @param {number} amount - Amount to withdraw.
 * @param {string} paycrestOrderId - Paycrest order ID.
 * @param {object} metadata - Additional metadata.
 */
async function withdrawFromBlockradar(chain, assetId, receiveAddress, amount, paycrestOrderId, metadata) {
  // Placeholder: Implement actual withdrawal via Blockradar's API
  // For demonstration, assume withdrawal is successful
  return;
}

// =================== Define Scenes ===================

// =================== Feedback Scene ===================
const feedbackScene = new Scenes.WizardScene(
  'feedback_scene',
  // Step 1: Ask for Feedback
  async (ctx) => {
    try {
      await ctx.reply('💬 *We Value Your Feedback*\n\nPlease share your thoughts or suggestions to help us improve DirectPay:');
      return ctx.wizard.next();
    } catch (error) {
      logger.error(`Error in feedback_scene Step 1: ${error.message}`);
      await ctx.replyWithMarkdown('⚠️ An error occurred. Please try again later.');
      ctx.scene.leave();
    }
  },
  // Step 2: Confirm Receipt of Feedback
  async (ctx) => {
    try {
      const feedback = ctx.message.text.trim();
      const userId = ctx.from.id.toString();

      if (!feedback) {
        await ctx.replyWithMarkdown('❌ Feedback cannot be empty. Please provide your feedback:');
        return; // Remain in the current step
      }

      await db.collection('feedback').add({
        userId,
        feedback,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
      });
      await ctx.reply('🙏 Thank you for your feedback!');
      ctx.scene.leave();
    } catch (error) {
      logger.error(`Error in feedback_scene Step 2: ${error.message}`);
      await ctx.replyWithMarkdown('⚠️ An error occurred while saving your feedback. Please try again later.');
      ctx.scene.leave();
    }
  }
);

// =================== Create PIN Scene ===================
const createPinScene = new Scenes.WizardScene(
  'create_pin_scene',
  // Step 1: Enter PIN
  async (ctx) => {
    try {
      ctx.scene.state.pinDigits = [];
      // **Updated Message for Clarity**
      await ctx.replyWithMarkdown('🔒 *Set Up Your 4-Digit PIN*\n\nPlease enter your PIN:', Markup.removeKeyboard());
      // Await text input
      return ctx.wizard.next();
    } catch (error) {
      logger.error(`Error in create_pin_scene Step 1: ${error.message}`);
      await ctx.replyWithMarkdown('⚠️ An error occurred. Please try again later.');
      ctx.scene.leave();
    }
  },
  // Step 2: Confirm PIN
  async (ctx) => {
    try {
      const input = ctx.message.text.trim();

      // Validate that the input is exactly 4 digits
      if (!/^\d{4}$/.test(input)) {
        await ctx.replyWithMarkdown('❌ *Invalid PIN.* Please enter a **4-digit numeric PIN**:');
        return; // Remain in the current step
      }

      ctx.scene.state.tempPin = input;
      logger.info(`User ${ctx.from.id} created PIN: ${input}`);

      // Delete the user's message containing the PIN
      await ctx.deleteMessage();

      // Prompt for confirmation
      await ctx.replyWithMarkdown('🔄 *Please confirm your 4-digit PIN:*', Markup.removeKeyboard());
      return ctx.wizard.next();
    } catch (error) {
      logger.error(`Error in create_pin_scene Step 2: ${error.message}`);
      await ctx.replyWithMarkdown('⚠️ An error occurred. Please try again later.');
      ctx.scene.leave();
    }
  },
  // Step 3: Verify PIN
  async (ctx) => {
    try {
      const confirmedPin = ctx.message.text.trim();

      // Validate that the input is exactly 4 digits
      if (!/^\d{4}$/.test(confirmedPin)) {
        await ctx.replyWithMarkdown('❌ *Invalid PIN.* Please enter a **4-digit numeric PIN** to confirm:');
        return; // Remain in the current step
      }

      // Delete the user's message containing the PIN
      await ctx.deleteMessage();

      if (confirmedPin !== ctx.scene.state.tempPin) {
        await ctx.replyWithMarkdown('❌ *PINs do not match.* Please start the PIN creation process again.');
        ctx.scene.leave();
        return;
      }

      // Hash the PIN before storing
      const hashedPin = await bcrypt.hash(confirmedPin, 10);

      // Store the hashed PIN in Firestore
      const userId = ctx.from.id.toString();
      await updateUserState(userId, { pin: hashedPin });

      await ctx.replyWithMarkdown('✅ *PIN has been set successfully!* Your PIN is required to edit bank details.');
      ctx.scene.leave();
    } catch (error) {
      logger.error(`Error in create_pin_scene Step 3: ${error.message}`);
      await ctx.replyWithMarkdown('⚠️ An error occurred while setting your PIN. Please try again later.');
      ctx.scene.leave();
    }
  }
);

// =================== Enter PIN Scene ===================
const enterPinScene = new Scenes.WizardScene(
  'enter_pin_scene',
  // Step 1: Enter PIN
  async (ctx) => {
    try {
      ctx.scene.state.enterPinDigits = [];
      await ctx.replyWithMarkdown('🔒 *Enter your 4-digit PIN*', Markup.removeKeyboard());
      // Await text input
      return ctx.wizard.next();
    } catch (error) {
      logger.error(`Error in enter_pin_scene Step 1: ${error.message}`);
      await ctx.replyWithMarkdown('⚠️ An error occurred. Please try again later.');
      ctx.scene.leave();
    }
  },
  // Step 2: Verify PIN
  async (ctx) => {
    try {
      const enteredPin = ctx.message.text.trim();

      // Validate that the input is exactly 4 digits
      if (!/^\d{4}$/.test(enteredPin)) {
        await ctx.replyWithMarkdown('❌ *Invalid PIN.* Please enter your **4-digit numeric PIN**:');
        return; // Remain in the current step
      }

      // Delete the user's message containing the PIN
      await ctx.deleteMessage();

      const userId = ctx.from.id.toString();
      const userState = await getUserState(userId);

      if (!userState.pin) {
        await ctx.reply('⚠️ No PIN found. Please set a PIN first.');
        ctx.scene.leave();
        return;
      }

      const isMatch = await bcrypt.compare(enteredPin, userState.pin);
      if (isMatch) {
        ctx.scene.state.pinVerified = true;
        await ctx.replyWithMarkdown('✅ *PIN verified successfully.* You can now edit your bank details.');

        // Proceed to edit bank details if applicable
        const walletIndex = ctx.scene.state.editBankWalletIndex;
        if (walletIndex !== undefined && walletIndex !== null) {
          await ctx.scene.enter('edit_bank_details_scene', { walletIndex });
        }

        ctx.scene.leave();
      } else {
        await ctx.replyWithMarkdown('❌ *Incorrect PIN.* Please try again.');
        // Optionally, implement rate limiting or account lockout after multiple attempts
      }
    } catch (error) {
      logger.error(`Error in enter_pin_scene Step 2: ${error.message}`);
      await ctx.replyWithMarkdown('⚠️ An error occurred while verifying your PIN. Please try again later.');
      ctx.scene.leave();
    }
  }
);

// =================== Bank Linking Scene ===================
const bankLinkingScene = new Scenes.WizardScene(
  'bank_linking_scene',
  // Step 0: Select Wallet to Link (if multiple unlinked wallets)
  async (ctx) => {
    try {
      const userId = ctx.from.id.toString();
      const userState = await getUserState(userId);
      const unlinkedWallets = userState.wallets
        .map((wallet, index) => ({ wallet, index }))
        .filter(w => !w.wallet.bank);

      if (unlinkedWallets.length === 0) {
        await ctx.replyWithMarkdown('✅ *All your wallets have linked bank accounts.*');
        return ctx.scene.leave();
      }

      if (unlinkedWallets.length === 1) {
        ctx.scene.state.bankLinkingWalletIndex = unlinkedWallets[0].index;
        await ctx.replyWithMarkdown(`🏦 *Linking Bank Account for Wallet ${unlinkedWallets[0].index + 1} (${unlinkedWallets[0].wallet.chain}):*\n\nPlease enter your bank name (e.g., Access Bank):`);
        return ctx.wizard.next();
      }

      // If multiple unlinked wallets, ask user to select one via text
      await ctx.replyWithMarkdown('🏦 *You have multiple unlinked wallets.*\n\nPlease enter the wallet number you want to link your bank account to (e.g., 1, 2):');
      return ctx.wizard.next();
    } catch (error) {
      logger.error(`Error in bank_linking_scene Step 0: ${error.message}`);
      await ctx.replyWithMarkdown('⚠️ An error occurred. Please try again later.');
      ctx.scene.leave();
    }
  },
  // Step 1: Enter Bank Name or Select Wallet
  async (ctx) => {
    try {
      const userId = ctx.from.id.toString();
      const currentStep = ctx.wizard.cursor; // 0-based index
      const input = ctx.message.text.trim();

      const userState = await getUserState(userId);
      const unlinkedWallets = userState.wallets
        .map((wallet, index) => ({ wallet, index }))
        .filter(w => !w.wallet.bank);

      if (unlinkedWallets.length > 1) {
        // User is expected to input wallet number
        const walletNumber = parseInt(input, 10);
        if (isNaN(walletNumber) || walletNumber < 1 || walletNumber > userState.wallets.length) {
          await ctx.replyWithMarkdown('❌ *Invalid wallet number.* Please enter a valid wallet number from the list:');
          // Optionally, list available wallets
          let walletListMessage = '🏦 *Available Wallets to Link:*\n\n';
          unlinkedWallets.forEach((w, idx) => {
            walletListMessage += `• *Wallet ${w.index + 1}:* ${w.wallet.chain}\n`;
          });
          await ctx.replyWithMarkdown(walletListMessage);
          return; // Remain in the current step
        }

        const selectedWalletIndex = walletNumber - 1; // Assuming wallet numbers start at 1
        if (!userState.wallets[selectedWalletIndex] || userState.wallets[selectedWalletIndex].bank) {
          await ctx.replyWithMarkdown('❌ *Selected wallet is already linked or does not exist.* Please choose another wallet.');
          return; // Remain in the current step
        }

        ctx.scene.state.bankLinkingWalletIndex = selectedWalletIndex;
        await ctx.replyWithMarkdown(`🏦 *Linking Bank Account for Wallet ${selectedWalletIndex + 1} (${userState.wallets[selectedWalletIndex].chain}):*\n\nPlease enter your bank name (e.g., Access Bank):`);
        return ctx.wizard.next();
      }

      // If only one unlinked wallet, proceed to enter bank name
      if (unlinkedWallets.length === 1) {
        const selectedWalletIndex = unlinkedWallets[0].index;
        ctx.scene.state.bankLinkingWalletIndex = selectedWalletIndex;
        await ctx.replyWithMarkdown(`🏦 *Linking Bank Account for Wallet ${selectedWalletIndex + 1} (${userState.wallets[selectedWalletIndex].chain}):*\n\nPlease enter your bank name (e.g., Access Bank):`);
        return ctx.wizard.next();
      }

      // No unlinked wallets found
      await ctx.replyWithMarkdown('✅ *All your wallets have linked bank accounts.*');
      ctx.scene.leave();
    } catch (error) {
      logger.error(`Error in bank_linking_scene Step 1: ${error.message}`);
      await ctx.replyWithMarkdown('⚠️ An error occurred. Please try again later.');
      ctx.scene.leave();
    }
  },
  // Step 2: Enter Bank Account Number
  async (ctx) => {
    try {
      const userId = ctx.from.id.toString();
      const currentStep = ctx.wizard.cursor; // 0-based index
      const input = ctx.message.text.trim();

      // Determine if the current step is bank name or account number
      if (currentStep === 1) { // Step 2: Enter Bank Account Number
        // Previous step was entering bank name
        const matchedBank = matchBank(ctx.scene.state.bankNameInput);
        if (!matchedBank) {
          await ctx.replyWithMarkdown('❌ *Invalid bank name.* Please enter a valid bank name from our supported list:\n\n' +
            bankList.map(b => `• ${b.name}`).join('\n'));
          return; // Remain in the current step
        }

        ctx.scene.state.bankData = {
          bankName: matchedBank.name,
          bankCode: matchedBank.code,
          paycrestInstitutionCode: matchedBank.paycrestInstitutionCode,
        };

        await ctx.replyWithMarkdown('🔢 *Please enter your 10-digit bank account number:*');
        return ctx.wizard.next();
      }

      if (currentStep === 2) { // Step 3: Confirmation
        const accountNumber = input;

        // Validate account number
        if (!/^\d{10}$/.test(accountNumber)) {
          await ctx.replyWithMarkdown('❌ *Invalid account number.* Please enter a valid 10-digit account number:');
          return; // Remain in the same step
        }

        ctx.scene.state.bankData.accountNumber = accountNumber;

        // Verify Bank Account
        await ctx.replyWithMarkdown('🔄 *Verifying your bank details...*');

        try {
          const verificationResult = await verifyBankAccount(ctx.scene.state.bankData.accountNumber, ctx.scene.state.bankData.bankCode);

          if (!verificationResult || !verificationResult.data) {
            throw new Error('Invalid verification response.');
          }

          const accountName = verificationResult.data.account_name;

          if (!accountName) {
            throw new Error('Unable to retrieve account name.');
          }

          ctx.scene.state.bankData.accountName = accountName;

          // Ask for Confirmation by Sending a New Message
          await ctx.replyWithMarkdown(
            `🏦 *Bank Account Verification*\n\n` +
            `Please confirm your bank details:\n` +
            `• *Bank Name:* ${ctx.scene.state.bankData.bankName}\n` +
            `• *Account Number:* ****${ctx.scene.state.bankData.accountNumber.slice(-4)}\n` +
            `• *Account Holder:* ${accountName}\n\n` +
            `Is this information correct?`,
            Markup.inlineKeyboard([
              [Markup.button.callback('✅ Yes, Confirm', 'confirm_bank_yes')],
              [Markup.button.callback('❌ No, Edit Details', 'confirm_bank_no')],
              [Markup.button.callback('❌ Cancel Linking', 'cancel_bank_linking')],
            ])
          );
          return ctx.wizard.next();
        } catch (error) {
          logger.error(`Error verifying bank account for user ${userId}: ${error.message}`);
          await ctx.replyWithMarkdown('❌ *Failed to verify your bank account.* Please ensure your details are correct or try again later.');
          ctx.scene.leave();
        }
      }
    } catch (error) {
      logger.error(`Error in bank_linking_scene Step 2: ${error.message}`);
      await ctx.replyWithMarkdown('⚠️ An error occurred. Please try again later.');
      ctx.scene.leave();
    }
  },
  // Step 3: Confirmation handled via action
  async (ctx) => {
    // No further steps; actions handle confirmation
    return;
  }
);

// Handle Bank Name Input
bankLinkingScene.on('text', async (ctx) => {
  try {
    const userId = ctx.from.id.toString();
    const currentStep = ctx.wizard.cursor; // 0-based index
    const input = ctx.message.text.trim();

    if (currentStep === 0) { // Selecting wallet to link
      // This step is handled in the previous wizard step
      // No action needed here
      return;
    }

    if (currentStep === 1) { // Enter Bank Name
      logger.info(`User ${userId} entered bank name: "${input}"`);

      const matchedBank = matchBank(input);

      if (!matchedBank) {
        await ctx.replyWithMarkdown(
          '❌ *Invalid bank name.* Please enter a valid bank name from our supported list:\n\n' +
          bankList.map(b => `• ${b.name}`).join('\n')
        );
        return; // Remain in the current step
      }

      ctx.scene.state.bankNameInput = input; // Store for validation
      ctx.scene.state.bankData = {
        bankName: matchedBank.name,
        bankCode: matchedBank.code,
        paycrestInstitutionCode: matchedBank.paycrestInstitutionCode,
      };

      await ctx.replyWithMarkdown('🔢 *Please enter your 10-digit bank account number:*');
      return ctx.wizard.next();
    }

    if (currentStep === 2) { // Enter Account Number
      logger.info(`User ${userId} entered account number: "${input}"`);

      if (!/^\d{10}$/.test(input)) {
        await ctx.replyWithMarkdown('❌ *Invalid account number.* Please enter a valid 10-digit account number:');
        return; // Remain in the same step
      }

      ctx.scene.state.bankData.accountNumber = input;

      // Verify Bank Account
      await ctx.replyWithMarkdown('🔄 *Verifying your bank details...*');

      try {
        const verificationResult = await verifyBankAccount(ctx.scene.state.bankData.accountNumber, ctx.scene.state.bankData.bankCode);

        if (!verificationResult || !verificationResult.data) {
          throw new Error('Invalid verification response.');
        }

        const accountName = verificationResult.data.account_name;

        if (!accountName) {
          throw new Error('Unable to retrieve account name.');
        }

        ctx.scene.state.bankData.accountName = accountName;

        // Ask for Confirmation by Sending a New Message
        await ctx.replyWithMarkdown(
          `🏦 *Bank Account Verification*\n\n` +
          `Please confirm your bank details:\n` +
          `• *Bank Name:* ${ctx.scene.state.bankData.bankName}\n` +
          `• *Account Number:* ****${ctx.scene.state.bankData.accountNumber.slice(-4)}\n` +
          `• *Account Holder:* ${accountName}\n\n` +
          `Is this information correct?`,
          Markup.inlineKeyboard([
            [Markup.button.callback('✅ Yes, Confirm', 'confirm_bank_yes')],
            [Markup.button.callback('❌ No, Edit Details', 'confirm_bank_no')],
            [Markup.button.callback('❌ Cancel Linking', 'cancel_bank_linking')],
          ])
        );
        return ctx.wizard.next();
      } catch (error) {
        logger.error(`Error verifying bank account for user ${userId}: ${error.message}`);
        await ctx.replyWithMarkdown('❌ *Failed to verify your bank account.* Please ensure your details are correct or try again later.');
        ctx.scene.leave();
      }
    }
  } catch (error) {
    logger.error(`Error handling text input in bank_linking_scene: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred. Please try again later.');
    ctx.scene.leave();
  }
});

// Handle confirmation "Yes, Confirm" within the scene
bankLinkingScene.action('confirm_bank_yes', async (ctx) => {
  try {
    const userId = ctx.from.id.toString();
    const walletIndex = ctx.scene.state.bankLinkingWalletIndex;
    const bankData = ctx.scene.state.bankData;

    if (walletIndex === undefined || walletIndex === null) {
      await ctx.reply('❌ No wallet selected for linking. Please try again.');
      ctx.scene.leave();
      return ctx.answerCbQuery();
    }

    const userState = await getUserState(userId);

    // Update the selected wallet with bank details
    if (!userState.wallets[walletIndex]) {
      await ctx.reply('❌ Selected wallet does not exist.');
      ctx.scene.leave();
      return ctx.answerCbQuery();
    }

    userState.wallets[walletIndex].bank = {
      bankName: bankData.bankName,
      bankCode: bankData.bankCode,
      accountNumber: bankData.accountNumber,
      accountName: bankData.accountName,
    };

    // Update user state in Firestore
    await updateUserState(userId, {
      wallets: userState.wallets,
    });

    await ctx.reply('✅ *Bank account linked successfully!*');

    // **Removed External PIN Prompt**
    // await ctx.reply('🔒 *Set Up Your 4-Digit PIN*');

    // **Enter the create_pin_scene directly**
    await ctx.scene.enter('create_pin_scene');

    ctx.scene.leave();
    ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error in confirm_bank_yes: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ *An error occurred while linking your bank account.* Please try again later.');
    ctx.scene.leave();
    ctx.answerCbQuery();
  }
});

// Handle confirmation "No, Edit Details" within the scene
bankLinkingScene.action('confirm_bank_no', async (ctx) => {
  try {
    await ctx.replyWithMarkdown('🔄 *Let\'s try entering your bank details again.*\n\nPlease enter your bank name (e.g., Access Bank):');
    ctx.scene.state.bankData = {}; // Reset bank data
    ctx.wizard.back(); // Go back to bank name input
    ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error in confirm_bank_no: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred. Please try again.');
    ctx.scene.leave();
    ctx.answerCbQuery();
  }
});

// Handle "Cancel Linking" within the scene
bankLinkingScene.action('cancel_bank_linking', async (ctx) => {
  try {
    await ctx.reply('❌ *Bank linking has been canceled.*');
    ctx.scene.leave();
    ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error in cancel_bank_linking: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred. Please try again.');
  }
});

// =================== Edit Bank Details Scene ===================
const editBankDetailsScene = new Scenes.WizardScene(
  'edit_bank_details_scene',
  // Step 1: Enter New Bank Name
  async (ctx) => {
    try {
      const { walletIndex } = ctx.scene.state;
      ctx.scene.state.editBankData = {};
      ctx.scene.state.editBankData.walletIndex = walletIndex;
      ctx.scene.state.editBankData.step = 1;
      await ctx.replyWithMarkdown('🏦 *Edit Bank Account*\n\nPlease enter your new bank name (e.g., Access Bank):');
      return ctx.wizard.next();
    } catch (error) {
      logger.error(`Error in edit_bank_details_scene Step 1: ${error.message}`);
      await ctx.replyWithMarkdown('⚠️ An error occurred. Please try again later.');
      ctx.scene.leave();
    }
  },
  // Step 2: Enter New Account Number
  async (ctx) => {
    // Handled by text input
    return;
  },
  // Step 3: Confirmation
  async (ctx) => {
    // Handled by actions
    return;
  }
);

// Handle text inputs in editBankDetailsScene
editBankDetailsScene.on('text', async (ctx) => {
  try {
    const userId = ctx.from.id.toString();
    const currentStep = ctx.wizard.cursor; // 0-based index
    const input = ctx.message.text.trim();

    if (currentStep === 1) { // Step 1: Enter New Bank Name
      logger.info(`User ${userId} entered new bank name: "${input}"`);

      const matchedBank = matchBank(input);

      if (!matchedBank) {
        await ctx.replyWithMarkdown(
          '❌ *Invalid bank name.* Please enter a valid bank name from our supported list:\n\n' +
          bankList.map(b => `• ${b.name}`).join('\n')
        );
        return; // Remain in the current step
      }

      ctx.scene.state.editBankData.newBankName = matchedBank.name;
      ctx.scene.state.editBankData.newBankCode = matchedBank.code;
      ctx.scene.state.editBankData.step = 2;

      await ctx.replyWithMarkdown('🔢 Please enter your new 10-digit bank account number:');
      return ctx.wizard.next();
    }

    if (currentStep === 2) { // Step 2: Enter New Account Number
      logger.info(`User ${userId} entered new account number: "${input}"`);

      if (!/^\d{10}$/.test(input)) {
        await ctx.replyWithMarkdown('❌ *Invalid account number.* Please enter a valid 10-digit account number:');
        return; // Remain in the same step
      }

      ctx.scene.state.editBankData.newAccountNumber = input;

      // Verify Bank Account
      await ctx.replyWithMarkdown('🔄 *Verifying your new bank details...*');

      try {
        const verificationResult = await verifyBankAccount(ctx.scene.state.editBankData.newAccountNumber, ctx.scene.state.editBankData.newBankCode);

        if (!verificationResult || !verificationResult.data) {
          throw new Error('Invalid verification response.');
        }

        const accountName = verificationResult.data.account_name;

        if (!accountName) {
          throw new Error('Unable to retrieve account name.');
        }

        ctx.scene.state.editBankData.newAccountName = accountName;

        // Ask for Confirmation by Sending a New Message
        await ctx.replyWithMarkdown(
          `🏦 *New Bank Account Verification*\n\n` +
          `Please confirm your new bank details:\n` +
          `- *Bank Name:* ${ctx.scene.state.editBankData.newBankName}\n` +
          `- *Account Number:* ****${ctx.scene.state.editBankData.newAccountNumber.slice(-4)}\n` +
          `- *Account Holder:* ${accountName}\n\n` +
          `Is this information correct?`,
          Markup.inlineKeyboard([
            [Markup.button.callback('✅ Yes, Confirm', 'confirm_new_bank_yes')],
            [Markup.button.callback('❌ No, Edit Details', 'confirm_new_bank_no')],
            [Markup.button.callback('❌ Cancel Editing', 'cancel_edit_bank')],
          ])
        );
        return ctx.wizard.next();
      } catch (error) {
        logger.error(`Error verifying new bank account for user ${userId}: ${error.message}`);
        await ctx.replyWithMarkdown('❌ *Failed to verify your new bank account.* Please ensure your details are correct or try again later.');
        ctx.scene.leave();
      }
    }
  } catch (error) {
    logger.error(`Error in edit_bank_details_scene on 'text': ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred. Please try again later.');
    ctx.scene.leave();
  }
});

// Handle confirmation "Yes, Confirm" for new bank details
editBankDetailsScene.action('confirm_new_bank_yes', async (ctx) => {
  try {
    const userId = ctx.from.id.toString();
    const walletIndex = ctx.scene.state.editBankData.walletIndex;
    const newBankData = ctx.scene.state.editBankData;

    if (walletIndex === undefined || walletIndex === null) {
      await ctx.reply('❌ No wallet selected for editing. Please try again.');
      ctx.scene.leave();
      return ctx.answerCbQuery();
    }

    const userState = await getUserState(userId);

    // Update the selected wallet with new bank details
    if (!userState.wallets[walletIndex]) {
      await ctx.reply('❌ Selected wallet does not exist.');
      ctx.scene.leave();
      return ctx.answerCbQuery();
    }

    userState.wallets[walletIndex].bank = {
      bankName: newBankData.newBankName,
      bankCode: newBankData.newBankCode,
      accountNumber: newBankData.newAccountNumber,
      accountName: newBankData.newAccountName,
    };

    // Update user state in Firestore
    await updateUserState(userId, {
      wallets: userState.wallets,
    });

    await ctx.reply('✅ *Bank account updated successfully!*');
    ctx.scene.leave();
    ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error in confirm_new_bank_yes: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ *An error occurred while updating your bank account.* Please try again later.');
    ctx.scene.leave();
    ctx.answerCbQuery();
  }
});

// Handle confirmation "No, Edit Details" for new bank details
editBankDetailsScene.action('confirm_new_bank_no', async (ctx) => {
  try {
    await ctx.replyWithMarkdown('🔄 *Let\'s try entering your new bank details again.*\n\nPlease enter your new bank name (e.g., Access Bank):');
    ctx.scene.state.editBankData = {}; // Reset bank data
    ctx.wizard.back(); // Go back to bank name input
    ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error in confirm_new_bank_no: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred. Please try again.');
    ctx.scene.leave();
    ctx.answerCbQuery();
  }
});

// Handle "Cancel Editing"
editBankDetailsScene.action('cancel_edit_bank', async (ctx) => {
  try {
    await ctx.reply('❌ *Bank editing has been canceled.*');
    ctx.scene.leave();
    ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error in cancel_edit_bank: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred. Please try again.');
  }
});

// =================== Send Message Scene ===================
const sendMessageScene = new Scenes.WizardScene(
  'send_message_scene',
  // Step 1: Ask for Recipient User ID
  async (ctx) => {
    try {
      await ctx.reply('📨 *Send Message to User*\n\nPlease enter the Telegram User ID of the recipient:');
      return ctx.wizard.next();
    } catch (error) {
      logger.error(`Error in send_message_scene Step 1: ${error.message}`);
      await ctx.replyWithMarkdown('⚠️ An error occurred. Please try again later.');
      ctx.scene.leave();
    }
  },
  // Step 2: Ask for Message Content
  async (ctx) => {
    try {
      const recipientId = ctx.message.text.trim();

      if (!/^\d+$/.test(recipientId)) {
        await ctx.replyWithMarkdown('❌ *Invalid User ID.* Please enter a numeric Telegram User ID:');
        return; // Remain on the same step
      }

      ctx.scene.state.adminSendMessage = { recipientId };
      await ctx.reply('✍️ *Please enter the message you want to send:*');
      return ctx.wizard.next();
    } catch (error) {
      logger.error(`Error in send_message_scene Step 2: ${error.message}`);
      await ctx.replyWithMarkdown('⚠️ An error occurred. Please try again later.');
      ctx.scene.leave();
    }
  },
  // Step 3: Confirm and Send Message
  async (ctx) => {
    try {
      const messageContent = ctx.message.text.trim();
      const recipientId = ctx.scene.state.adminSendMessage.recipientId;

      if (!messageContent) {
        await ctx.replyWithMarkdown('❌ *Message content cannot be empty.* Please enter the message you want to send:');
        return; // Remain on the same step
      }

      await bot.telegram.sendMessage(recipientId, messageContent, { parse_mode: 'Markdown' });
      await ctx.replyWithMarkdown(`✅ Message sent to user ID: ${recipientId}`);
      ctx.scene.leave();
    } catch (error) {
      logger.error(`Error in send_message_scene Step 3: ${error.message}`);
      await ctx.replyWithMarkdown(`❌ Failed to send message to user ID: ${ctx.scene.state.adminSendMessage.recipientId}. Please ensure the User ID is correct and the user has interacted with the bot.`);
      ctx.scene.leave();
    }
  }
);

// =================== Receipt Generation Scene ===================
const receiptGenerationScene = new Scenes.WizardScene(
  'receipt_generation_scene',
  // Step 1: Ask for Reference ID
  async (ctx) => {
    try {
      await ctx.reply('🧾 *Generate Transaction Receipt*\n\nPlease enter the Reference ID of the transaction:');
      return ctx.wizard.next();
    } catch (error) {
      logger.error(`Error in receipt_generation_scene Step 1: ${error.message}`);
      await ctx.replyWithMarkdown('⚠️ An error occurred. Please try again later.');
      ctx.scene.leave();
    }
  },
  // Step 2: Fetch and Send Receipt
  async (ctx) => {
    try {
      const referenceId = ctx.message.text.trim();
      const userId = ctx.from.id.toString();

      if (!referenceId) {
        await ctx.replyWithMarkdown('❌ Reference ID cannot be empty. Please enter the Reference ID of the transaction:');
        return; // Remain on the same step
      }

      const txSnapshot = await db.collection('transactions').where('referenceId', '==', referenceId).limit(1).get();
      if (txSnapshot.empty) {
        await ctx.replyWithMarkdown('❌ No transaction found with the provided Reference ID.');
        return ctx.scene.leave();
      }

      const txData = txSnapshot.docs[0].data();
      const receipt = generateReceipt(txData);

      await ctx.replyWithMarkdown(receipt);
      ctx.scene.leave();
    } catch (error) {
      logger.error(`Error in receipt_generation_scene Step 2: ${error.message}`);
      await ctx.replyWithMarkdown('⚠️ An error occurred while generating the receipt. Please try again later.');
      ctx.scene.leave();
    }
  }
);

/**
 * Generates a transaction receipt.
 * Placeholder function; replace with actual receipt generation logic.
 * @param {object} txData - Transaction data.
 * @returns {string} - Formatted receipt.
 */
function generateReceipt(txData) {
  // Placeholder: Implement actual receipt formatting
  return `
🧾 *Transaction Receipt*

• *Reference ID:* \`${txData.referenceId}\`
• *User ID:* ${txData.userId}
• *Amount Deposited:* ${txData.amount} ${txData.asset}
• *Payout:* ₦${txData.payout}
• *Chain:* ${txData.chain}
• *Status:* ${txData.status}
• *Date:* ${new Date(txData.timestamp).toLocaleString()}
• *Transaction Hash:* \`${txData.transactionHash}\`

*Thank you for using DirectPay!*
  `;
}

// =================== Broadcast Message Scene ===================
const broadcastMessageScene = new Scenes.WizardScene(
  'broadcast_message_scene',
  // Step 1: Ask for Broadcast Message
  async (ctx) => {
    try {
      await ctx.reply('📢 *Broadcast Message*\n\nPlease enter the message you want to send to all users:');
      return ctx.wizard.next();
    } catch (error) {
      logger.error(`Error in broadcast_message_scene Step 1: ${error.message}`);
      await ctx.replyWithMarkdown('⚠️ An error occurred. Please try again later.');
      ctx.scene.leave();
    }
  },
  // Step 2: Confirm and Send Broadcast
  async (ctx) => {
    try {
      const message = ctx.message.text.trim();

      if (!message) {
        await ctx.replyWithMarkdown('❌ *Broadcast message cannot be empty.* Please enter the message you want to send:');
        return; // Remain on the same step
      }

      const usersSnapshot = await db.collection('users').get();
      if (usersSnapshot.empty) {
        await ctx.replyWithMarkdown('⚠️ No users found to send messages.');
        return ctx.scene.leave();
      }

      let successCount = 0;
      let failureCount = 0;

      for (const userDoc of usersSnapshot.docs) {
        const userId = userDoc.id;
        try {
          await bot.telegram.sendMessage(userId, message, { parse_mode: 'Markdown' });
          successCount++;
        } catch (error) {
          logger.error(`Error sending broadcast to user ${userId}: ${error.message}`);
          failureCount++;
        }
      }

      await ctx.replyWithMarkdown(`✅ Broadcast sent successfully!\n\n• *Success:* ${successCount}\n• *Failed:* ${failureCount}`);
      ctx.scene.leave();
    } catch (error) {
      logger.error(`Error in broadcast_message_scene Step 2: ${error.message}`);
      await ctx.replyWithMarkdown('⚠️ An error occurred while sending the broadcast. Please try again later.');
      ctx.scene.leave();
    }
  }
);

// =================== Admin Panel Scene ===================

/**
 * Admin Panel is handled via action callbacks, no separate scene needed.
 */

// =================== Register All Scenes with Stage ===================
const stage = new Scenes.Stage();

stage.register(
  feedbackScene,
  createPinScene,
  enterPinScene,
  bankLinkingScene,
  sendMessageScene,
  receiptGenerationScene,
  editBankDetailsScene,
  broadcastMessageScene // Ensure this is defined before registration
);

// Apply session and stage middleware
bot.use(session());
bot.use(stage.middleware());

// =================== Exchange Rate Fetching ===================
const SUPPORTED_ASSETS = ['USDC', 'USDT'];
let exchangeRates = {
  USDC: 0,
  USDT: 0
};

/**
 * Fetches the exchange rate for a given asset from Paycrest.
 * @param {string} asset - Asset symbol (USDC/USDT).
 * @returns {number} - Exchange rate.
 */
async function fetchExchangeRate(asset) {
  try {
    const response = await axios.get(`${PAYCREST_RATE_API_URL}`, {
      headers: {
        'Authorization': `Bearer ${PAYCREST_API_KEY}`,
        'Content-Type': 'application/json'
      },
    });

    if (response.data.status === 'success' && response.data.data) {
      const rate = parseFloat(response.data.data);
      if (isNaN(rate)) {
        throw new Error(`Invalid rate data for ${asset}: ${response.data.data}`);
      }
      return rate;
    } else {
      throw new Error(`Failed to fetch rate for ${asset}: ${response.data.message || 'Unknown error'}`);
    }
  } catch (error) {
    logger.error(`Error fetching exchange rate for ${asset} from Paycrest: ${error.message}`);
    throw error;
  }
}

/**
 * Fetches exchange rates for all supported assets.
 */
async function fetchExchangeRates() {
  try {
    const rates = {};
    for (const asset of SUPPORTED_ASSETS) {
      rates[asset] = await fetchExchangeRate(asset);
    }
    exchangeRates = rates;
    logger.info('Exchange rates updated successfully from Paycrest.');
  } catch (error) {
    logger.error(`Error fetching exchange rates from Paycrest: ${error.message}`);
    // Optionally, retain previous rates or handle as needed
  }
}

// Initial fetch
fetchExchangeRates();

// Update Exchange Rates Every 5 Minutes
setInterval(fetchExchangeRates, 300000); // 5 minutes

// =================== Main Menu ===================
/**
 * Generates the Main Menu keyboard based on user state.
 * @param {boolean} walletExists - Whether the user has any wallets.
 * @param {boolean} hasBankLinked - Whether the user has any bank linked.
 * @returns {Markup} - Telegram keyboard markup.
 */
const getMainMenu = (walletExists, hasBankLinked) =>
  Markup.keyboard([
    [walletExists ? '💼 View Wallet' : '💼 Generate Wallet', hasBankLinked ? '⚙️ Settings' : '🏦 Link Bank Account'],
    ['💰 Transactions', 'ℹ️ Support', '📘 Learn About Base'],
    ['📈 View Current Rates'], // Added Refresh Rates Button
  ]).resize();

// =================== /start Command ===================
bot.start(async (ctx) => {
  try {
    await greetUser(ctx);
  } catch (error) {
    logger.error(`Error in /start command: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred. Please try again later.');
  }
});

/**
 * Greets the user and provides the main menu.
 * @param {TelegrafContext} ctx - Telegraf context.
 */
async function greetUser(ctx) {
  const userId = ctx.from.id.toString();
  let userState;
  try {
    userState = await getUserState(userId);

    // If firstName is empty, update it from ctx.from.first_name
    if (!userState.firstName) {
      await db.collection('users').doc(userId).update({
        firstName: ctx.from.first_name || 'Valued User'
      });
      userState.firstName = ctx.from.first_name || 'Valued User';
    }
  } catch (error) {
    logger.error(`Error fetching user state for ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred. Please try again later.');
    return;
  }

  const walletExists = userState.wallets.length > 0;
  const hasBankLinked = userState.wallets.some(wallet => wallet.bank);
  const adminUser = isAdmin(userId);

  const greeting = walletExists
    ? `👋 Hello, ${userState.firstName}!\n\nWelcome back to **DirectPay**, your gateway to seamless crypto transactions.\n\n💡 **Quick Start Guide:**\n1. **Add Your Bank Account**\n2. **Access Your Dedicated Wallet Address**\n3. **Send Stablecoins and Receive Cash Instantly**\n\nWe offer competitive rates and real-time updates to keep you informed. Your funds are secure, and you'll have cash in your account promptly!\n\nLet's get started!`
    : `👋 Welcome, ${userState.firstName}!\n\nThank you for choosing **DirectPay**. Let's embark on your crypto journey together. Use the menu below to get started.`;

  if (adminUser) {
    const sentMessage = await ctx.replyWithMarkdown(greeting, Markup.inlineKeyboard([
      [Markup.button.callback('🔧 Admin Panel', 'open_admin_panel')],
    ]));
    ctx.session.adminMessageId = sentMessage.message_id;
  } else {
    await ctx.replyWithMarkdown(greeting, getMainMenu(walletExists, hasBankLinked));
  }
}

// =================== Generate Wallet Handler ===================
bot.hears('💼 Generate Wallet', async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    const userState = await getUserState(userId);
    
    if (userState.wallets.length >= MAX_WALLETS) {
      return ctx.replyWithMarkdown(`⚠️ You have reached the maximum number of wallets (${MAX_WALLETS}). Please manage your existing wallets before adding new ones.`);
    }
    
    // Added exchange rate information during wallet generation
    let ratesMessage = '📈 *Current Exchange Rates*:\n\n';
    for (const [asset, rate] of Object.entries(exchangeRates)) {
      ratesMessage += `• *${asset}*: ₦${rate}\n`;
    }
    ratesMessage += `\nThese rates will be applied during your deposits and payouts.`;

    await ctx.replyWithMarkdown(ratesMessage);

    await ctx.reply('📂 *Select the network for which you want to generate a wallet:*', Markup.inlineKeyboard([
      [Markup.button.callback('Base', 'generate_wallet_Base')],
      [Markup.button.callback('Polygon', 'generate_wallet_Polygon')],
      [Markup.button.callback('BNB Smart Chain', 'generate_wallet_BNB Smart Chain')],
    ]));
  } catch (error) {
    logger.error(`Error handling Generate Wallet for user ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred while generating your wallet. Please try again later.');
  }
});

// Handle Wallet Generation for Inline Buttons
bot.action(/generate_wallet_(.+)/, async (ctx) => {
  try {
    const userId = ctx.from.id.toString();
    const selectedChainRaw = ctx.match[1]; // e.g., 'Base', 'Polygon', 'BNB Smart Chain'

    // Normalize and map the selected chain
    const selectedChainKey = chainMapping[selectedChainRaw.toLowerCase()];
    if (!selectedChainKey) {
      await ctx.replyWithMarkdown('⚠️ Invalid network selection. Please try again.');
      return ctx.answerCbQuery(); // Acknowledge the callback to remove loading state
    }

    const chain = selectedChainKey;

    // Check if the user is already in the bank_linking_scene
    if (ctx.scene.current === 'bank_linking_scene') {
      await ctx.reply('🔄 *You are already in the process of linking a bank account. Please complete the current process before starting a new one.*');
      return ctx.answerCbQuery(); // Acknowledge the callback to remove loading state
    }

    // Acknowledge the Callback to Remove Loading State
    await ctx.answerCbQuery();

    // Inform User That Wallet Generation Has Started with Progress Indicator
    const progressMessage = await ctx.replyWithMarkdown('🔄 Generating your wallet. Please wait...');

    try {
      const walletAddress = await generateWallet(chain);

      // Fetch Updated User State
      const userState = await getUserState(userId);

      if (userState.wallets.length >= MAX_WALLETS) {
        await ctx.replyWithMarkdown(`⚠️ You cannot generate more than ${MAX_WALLETS} wallets.`);
        await ctx.deleteMessage(progressMessage.message_id);
        return;
      }

      // Add the New Wallet to User State
      userState.wallets.push({
        address: walletAddress || 'N/A',
        chain: chain || 'N/A',
        supportedAssets: chains[chain].supportedAssets ? [...chains[chain].supportedAssets] : [],
        bank: null,
        amount: 0 // Initialize amount if needed
      });

      // Also, Add the Wallet Address to walletAddresses Array
      const updatedWalletAddresses = userState.walletAddresses || [];
      updatedWalletAddresses.push(walletAddress);

      // Update User State in Firestore
      await updateUserState(userId, {
        wallets: userState.wallets,
        walletAddresses: updatedWalletAddresses,
      });

      // Log Wallet Generation
      await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `💼 Wallet generated for user ${userId} on ${chain}: ${walletAddress}`, { parse_mode: 'Markdown' });
      logger.info(`Wallet generated for user ${userId} on ${chain}: ${walletAddress}`);

      // Set walletIndex to the newly created wallet
      const newWalletIndex = userState.wallets.length - 1;
      ctx.scene.state.walletIndex = newWalletIndex;

      // Delete the Progress Message
      await ctx.deleteMessage(progressMessage.message_id);

      // Enter the Bank Linking Wizard Scene Immediately
      await ctx.scene.enter('bank_linking_scene');
    } catch (error) {
      logger.error(`Error generating wallet for user ${userId} on ${chain}: ${error.message}`);
      await ctx.replyWithMarkdown('⚠️ There was an issue generating your wallet. Please try again later.');
      await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ Error generating wallet for user ${userId}: ${error.message}`, { parse_mode: 'Markdown' });
      // Delete the Progress Message
      await ctx.deleteMessage(progressMessage.message_id);
    }
  } catch (error) {
    logger.error(`Error in generate_wallet action: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An unexpected error occurred. Please try again later.');
    ctx.answerCbQuery();
  }
});

// =================== View Wallet Handler ===================
bot.hears('💼 View Wallet', async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    const userState = await getUserState(userId);
    
    if (userState.wallets.length === 0) {
      return ctx.replyWithMarkdown('❌ You have no wallets. Please generate a wallet first using the "💼 Generate Wallet" option.');
    }

    // Implement Pagination
    const pageSize = 5; // Number of wallets per page
    const totalPages = Math.ceil(userState.wallets.length / pageSize) || 1;
    ctx.scene.state.walletsPage = 1; // Initialize to first page

    const generateWalletPage = (page) => {
      const start = (page - 1) * pageSize;
      const end = start + pageSize;
      const wallets = userState.wallets.slice(start, end);

      let message = `💼 *Your Wallets* (Page ${page}/${totalPages}):\n\n`;
      wallets.forEach((wallet, index) => {
        const walletNumber = start + index + 1;
        message += `*Wallet ${walletNumber}:*\n`;
        message += `• *Chain:* ${wallet.chain}\n`;
        message += `• *Address:* \`${wallet.address}\`\n`;
        message += `• *Bank Linked:* ${wallet.bank ? '✅ Yes' : '❌ No'}\n\n`;
      });

      // Add Key Metrics
      let totalDeposited = 0;
      let totalWithdrawn = 0;
      userState.wallets.forEach(wallet => {
        wallet.transactions?.forEach(tx => {
          if (tx.status === 'Completed') {
            totalDeposited += parseFloat(tx.amount) || 0;
            totalWithdrawn += parseFloat(tx.payout) || 0;
          }
        });
      });

      message += `*Key Metrics:*\n`;
      message += `• *Total Deposited:* ${totalDeposited} ${userState.wallets[0].supportedAssets[0] || 'N/A'}\n`;
      message += `• *Total Withdrawn:* ₦${totalWithdrawn}\n`;
      message += `• *Number of Active Wallets:* ${userState.wallets.length}\n`;

      const navigationButtons = [];

      if (page > 1) {
        navigationButtons.push(Markup.button.callback('⬅️ Previous', `wallet_page_${page - 1}`));
      }
      if (page < totalPages) {
        navigationButtons.push(Markup.button.callback('Next ➡️', `wallet_page_${page + 1}`));
      }
      navigationButtons.push(Markup.button.callback('🔄 Refresh', `wallet_page_${page}`));

      const inlineKeyboard = Markup.inlineKeyboard([navigationButtons]);

      return { message, inlineKeyboard };
    };

    const { message, inlineKeyboard } = generateWalletPage(ctx.scene.state.walletsPage);
    await ctx.replyWithMarkdown(message, inlineKeyboard);
  } catch (error) {
    logger.error(`Error fetching wallets for user ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ Unable to fetch your wallets. Please try again later.');
  }
});

// Handle Wallet Page Navigation
bot.action(/wallet_page_(\d+)/, async (ctx) => {
  try {
    const userId = ctx.from.id.toString();
    const requestedPage = parseInt(ctx.match[1], 10);

    const userState = await getUserState(userId);
    const pageSize = 5;
    const totalPages = Math.ceil(userState.wallets.length / pageSize) || 1;

    if (requestedPage < 1 || requestedPage > totalPages) {
      return ctx.answerCbQuery('⚠️ Invalid page number.', { show_alert: true });
    }

    ctx.scene.state.walletsPage = requestedPage;

    const start = (requestedPage - 1) * pageSize;
    const end = start + pageSize;
    const wallets = userState.wallets.slice(start, end);

    let message = `💼 *Your Wallets* (Page ${requestedPage}/${totalPages}):\n\n`;
    wallets.forEach((wallet, index) => {
      const walletNumber = start + index + 1;
      message += `*Wallet ${walletNumber}:*\n`;
      message += `• *Chain:* ${wallet.chain}\n`;
      message += `• *Address:* \`${wallet.address}\`\n`;
      message += `• *Bank Linked:* ${wallet.bank ? '✅ Yes' : '❌ No'}\n\n`;
    });

    // Add Key Metrics
    let totalDeposited = 0;
    let totalWithdrawn = 0;
    userState.wallets.forEach(wallet => {
      wallet.transactions?.forEach(tx => {
        if (tx.status === 'Completed') {
          totalDeposited += parseFloat(tx.amount) || 0;
          totalWithdrawn += parseFloat(tx.payout) || 0;
        }
      });
    });

    message += `*Key Metrics:*\n`;
    message += `• *Total Deposited:* ${totalDeposited} ${userState.wallets[0].supportedAssets[0] || 'N/A'}\n`;
    message += `• *Total Withdrawn:* ₦${totalWithdrawn}\n`;
    message += `• *Number of Active Wallets:* ${userState.wallets.length}\n`;

    const navigationButtons = [];

    if (requestedPage > 1) {
      navigationButtons.push(Markup.button.callback('⬅️ Previous', `wallet_page_${requestedPage - 1}`));
    }
    if (requestedPage < totalPages) {
      navigationButtons.push(Markup.button.callback('Next ➡️', `wallet_page_${requestedPage + 1}`));
    }
    navigationButtons.push(Markup.button.callback('🔄 Refresh', `wallet_page_${requestedPage}`));

    const inlineKeyboard = Markup.inlineKeyboard([navigationButtons]);

    await ctx.editMessageText(message, { parse_mode: 'Markdown', reply_markup: inlineKeyboard.reply_markup });
    ctx.answerCbQuery(); // Acknowledge the callback
  } catch (error) {
    logger.error(`Error navigating wallet pages for user ${ctx.from.id}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred while navigating wallets. Please try again later.');
    ctx.answerCbQuery();
  }
});

// =================== Settings Handler ===================
bot.hears('⚙️ Settings', async (ctx) => {
  try {
    await ctx.reply('⚙️ *Settings Menu*', getSettingsMenu());
  } catch (error) {
    logger.error(`Error handling Settings for user ${ctx.from.id}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred. Please try again later.');
  }
});

/**
 * Generates the Settings Menu Inline Keyboard.
 * @returns {Markup} - Inline Keyboard Markup.
 */
const getSettingsMenu = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('🔄 Generate New Wallet', 'settings_generate_wallet')],
    [Markup.button.callback('✏️ Edit Linked Bank Details', 'settings_edit_bank')],
    [Markup.button.callback('💬 Support', 'settings_support')],
    [Markup.button.callback('🧾 Generate Transaction Receipt', 'settings_generate_receipt')],
    [Markup.button.callback('🔙 Back to Main Menu', 'settings_back_main')],
  ]);

// =================== Check if User is Admin ===================
/**
 * Checks if a user is an admin based on their user ID.
 * @param {string} userId - Telegram user ID.
 * @returns {boolean} - Whether the user is an admin.
 */
const isAdmin = (userId) => ADMIN_IDS.split(',').map(id => id.trim()).includes(userId.toString());

// =================== Rating Handlers ===================
// Define the feedback options after rating
const feedbackOptions = Markup.inlineKeyboard([
  [Markup.button.callback('💬 Give Feedback', 'give_feedback')],
  [Markup.button.callback('❌ Leave', 'leave_feedback')],
]);

// Handle rating selections (1-5 stars) with vertical inline menu
bot.action(/rate_(\d+)/, async (ctx) => {
  try {
    const userId = ctx.from.id.toString();
    const rating = parseInt(ctx.match[1], 10);
    
    // Log the rating
    logger.info(`User ${userId} rated the service with ${rating} star(s).`);
    
    // Store rating in Firestore (optional)
    try {
      await db.collection('ratings').add({
        userId: userId,
        rating: rating,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
      });
    } catch (error) {
      logger.error(`Error storing rating for user ${userId}: ${error.message}`);
    }
    
    // Delete the rating message
    try {
      await ctx.deleteMessage();
    } catch (error) {
      logger.error(`Error deleting rating message for user ${userId}: ${error.message}`);
    }
    
    // Thank the user
    await ctx.reply('🙏 Thank you for your rating!');
    
    // Ask if they want to provide additional feedback
    await ctx.reply('Would you like to provide additional feedback?', feedbackOptions);
    
    // Acknowledge the callback to remove the loading state
    await ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error handling rating action: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred. Please try again later.');
    await ctx.answerCbQuery();
  }
});

// Handle 'Give Feedback' button
bot.action('give_feedback', async (ctx) => {
  try {
    await ctx.scene.enter('feedback_scene'); // Enter the feedback collection scene
    await ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error entering feedback_scene: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred. Please try again later.');
    await ctx.answerCbQuery();
  }
});

// Handle 'Leave' button
bot.action('leave_feedback', async (ctx) => {
  try {
    await ctx.reply('Thank you for using DirectPay! If you have any suggestions or need assistance, feel free to reach out.');
    await ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error handling leave_feedback: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred. Please try again.');
  }
});

// =================== Bank Linking Scene ===================
// Already handled above

// =================== Admin Panel ===================

// Entry point for Admin Panel
bot.action('open_admin_panel', async (ctx) => {
  try {
    const userId = ctx.from.id.toString();
    if (!isAdmin(userId)) {
      return ctx.reply('⚠️ Unauthorized access.');
    }

    // Reset session variables if necessary
    ctx.scene.state.adminMessageId = null;

    const sentMessage = await ctx.reply('👨‍💼 **Admin Panel**\n\nSelect an option below:', getAdminMenu());
    ctx.scene.state.adminMessageId = sentMessage.message_id;
  } catch (error) {
    logger.error(`Error opening admin panel for user ${ctx.from.id}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred while opening the admin panel.');
  }
});

/**
 * Generates the Admin Menu Inline Keyboard.
 * @returns {Markup} - Inline Keyboard Markup.
 */
const getAdminMenu = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('📋 View Recent Transactions', 'admin_view_transactions')],
    [Markup.button.callback('📨 Send Message to User', 'admin_send_message')],
    [Markup.button.callback('✅ Mark Transactions as Paid', 'admin_mark_paid')],
    [Markup.button.callback('👥 View All Users', 'admin_view_users')],
    [Markup.button.callback('📢 Broadcast Message', 'admin_broadcast_message')],
    [Markup.button.callback('🔙 Back to Main Menu', 'admin_back_to_main')],
  ]);

// Handle Admin Menu Actions
bot.action(/admin_(.+)/, async (ctx) => {
  try {
    const userId = ctx.from.id.toString();

    if (!isAdmin(userId)) {
      return ctx.reply('⚠️ Unauthorized access.');
    }

    const action = ctx.match[1];

    switch (action) {
      case 'view_transactions':
        // Handle viewing transactions
        try {
          const transactionsSnapshot = await db.collection('transactions').orderBy('timestamp', 'desc').limit(10).get();

          if (transactionsSnapshot.empty) {
            await ctx.answerCbQuery('No transactions found.', { show_alert: true });
            return;
          }

          let message = '📋 **Recent Transactions**:\n\n';

          transactionsSnapshot.forEach((doc) => {
            const tx = doc.data();
            message += `*User ID:* ${tx.userId || 'N/A'}\n`;
            message += `*Reference ID:* \`${tx.referenceId || 'N/A'}\`\n`;
            message += `*Amount Deposited:* ${tx.amount || 'N/A'} ${tx.asset || 'N/A'}\n`;
            message += `*Status:* ${tx.status || 'Pending'}\n`;
            message += `*Chain:* ${tx.chain || 'N/A'}\n`;
            message += `*Date:* ${tx.timestamp ? new Date(tx.timestamp).toLocaleString() : 'N/A'}\n`;
            message += `*Details:* [View on Explorer](https://polygonscan.com/tx/${tx.transactionHash || 'N/A'})\n\n`; // Detailed Transaction View
          });

          // Add a 'Back' button to return to the admin menu
          const inlineKeyboard = Markup.inlineKeyboard([
            [Markup.button.callback('🔙 Back to Admin Menu', 'admin_back_to_main')]
          ]);

          // Edit the admin panel message
          await ctx.editMessageText(message, { parse_mode: 'Markdown', reply_markup: inlineKeyboard.reply_markup });
          ctx.answerCbQuery();
        } catch (error) {
          logger.error(`Error fetching all transactions: ${error.message}`);
          await ctx.answerCbQuery('⚠️ Unable to fetch transactions.', { show_alert: true });
        }
        break;

      case 'send_message':
        // Handle sending messages
        try {
          const usersSnapshot = await db.collection('users').get();
          if (usersSnapshot.empty) {
            await ctx.replyWithMarkdown('⚠️ No users found to send messages.');
            return ctx.answerCbQuery();
          }

          await ctx.scene.enter('send_message_scene');
          ctx.answerCbQuery();
        } catch (error) {
          logger.error(`Error initiating send message: ${error.message}`);
          await ctx.replyWithMarkdown('⚠️ An error occurred while initiating the message. Please try again later.');
          ctx.answerCbQuery();
        }
        break;

      case 'mark_paid':
        // Handle marking transactions as paid as a backup for admin 
        try {
          const pendingTransactions = await db.collection('transactions').where('status', '==', 'Pending').get();
          if (pendingTransactions.empty) {
            await ctx.answerCbQuery('No pending transactions found.', { show_alert: true });
            return;
          }

          const batch = db.batch();
          pendingTransactions.forEach((transaction) => {
            const docRef = db.collection('transactions').doc(transaction.id);
            batch.update(docRef, { status: 'Paid' });
          });

          await batch.commit();

          // Notify users about their transactions being marked as paid
          pendingTransactions.forEach(async (transaction) => {
            const txData = transaction.data();
            try {
              const payout = txData.payout || 'N/A';
              const accountName = txData.bankDetails && txData.bankDetails.accountName ? txData.bankDetails.accountName : 'Valued User';

              await bot.telegram.sendMessage(
                txData.userId,
                `🎉 *Transaction Successful!*\n\n` +
                `Hello ${accountName},\n\n` +
                `Your DirectPay order has been completed. Here are the details of your order:\n\n` +
                `*Crypto amount:* ${txData.amount} ${txData.asset}\n` +
                `• *Cash amount:* ₦${payout}\n` +
                `• *Network:* ${txData.chain}\n` +
                `• *Date:* ${new Date(txData.timestamp).toLocaleString()}\n`,
                { parse_mode: 'Markdown' }
              );
              logger.info(`Notified user ${txData.userId} about paid transaction ${txData.referenceId}`);
            } catch (error) {
              logger.error(`Error notifying user ${txData.userId}: ${error.message}`);
            }
          });

          // Edit the admin panel message to confirm
          await ctx.editMessageText('✅ All pending transactions have been marked as paid.', { reply_markup: getAdminMenu() });
          ctx.answerCbQuery();
        } catch (error) {
          logger.error(`Error marking transactions as paid: ${error.message}`);
          await ctx.answerCbQuery('⚠️ Error marking transactions as paid. Please try again later.', { show_alert: true });
        }
        break;

      case 'view_users':
        // Handle viewing all users
        try {
          const usersSnapshot = await db.collection('users').get();

          if (usersSnapshot.empty) {
            await ctx.answerCbQuery('No users found.', { show_alert: true });
            return;
          }

          let message = '👥 **All Users**:\n\n';

          usersSnapshot.forEach((doc) => {
            const user = doc.data();
            message += `*User ID:* ${doc.id}\n`;
            message += `*First Name:* ${user.firstName || 'N/A'}\n`;
            message += `*Number of Wallets:* ${user.wallets.length}\n`;
            message += `*Bank Linked:* ${user.wallets.some(wallet => wallet.bank) ? 'Yes' : 'No'}\n\n`;
          });

          // Add a 'Back' button to return to the admin menu
          const inlineKeyboard = Markup.inlineKeyboard([
            [Markup.button.callback('🔙 Back to Admin Menu', 'admin_back_to_main')]
          ]);

          // Edit the admin panel message
          await ctx.editMessageText(message, { parse_mode: 'Markdown', reply_markup: inlineKeyboard.reply_markup });
          ctx.answerCbQuery();
        } catch (error) {
          logger.error(`Error fetching all users: ${error.message}`);
          await ctx.answerCbQuery('⚠️ Unable to fetch users.', { show_alert: true });
        }
        break;

      case 'broadcast_message':
        // Handle sending broadcast messages to all users
        try {
          const usersSnapshot = await db.collection('users').get();
          if (usersSnapshot.empty) {
            await ctx.replyWithMarkdown('⚠️ No users available to broadcast.');
            return ctx.answerCbQuery();
          }

          // Prompt admin to enter the broadcast message
          await ctx.reply('📢 *Broadcast Message*\n\nPlease enter the message you want to broadcast to all users:');
          await ctx.scene.enter('broadcast_message_scene');
          ctx.answerCbQuery();
        } catch (error) {
          logger.error(`Error initiating broadcast message: ${error.message}`);
          await ctx.replyWithMarkdown('⚠️ An error occurred while initiating the broadcast. Please try again later.');
          ctx.answerCbQuery();
        }
        break;

      case 'admin_back_to_main':
        // Return to the main menu
        await greetUser(ctx);
        // Delete the admin panel message
        if (ctx.scene.state.adminMessageId) {
          await ctx.deleteMessage(ctx.scene.state.adminMessageId).catch(() => {});
          ctx.scene.state.adminMessageId = null;
        }
        ctx.answerCbQuery();
        break;

      default:
        await ctx.answerCbQuery('⚠️ Unknown action. Please select an option from the menu.', { show_alert: true });
    }
  } catch (error) {
    logger.error(`Error handling admin action: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred. Please try again later.');
    await ctx.answerCbQuery('⚠️ An error occurred.', { show_alert: true });
  }
});

// =================== Support Handlers ===================
const detailedTutorials = {
  how_it_works: `
**📘 How DirectPay Works**

1. **Generate Your Wallet:**
   - Navigate to the "💼 Generate Wallet" option.
   - Select your preferred network (Base, Polygon, BNB Smart Chain).
   - Receive a unique wallet address where you can receive USDC/USDT payments.

2. **Link Your Bank Account:**
   - After generating your wallet, provide your bank details to securely receive payouts directly into your bank account.

3. **Receive Payments:**
   - Share your wallet address with clients or payment sources.
   - Once a deposit is made, DirectPay will automatically convert the crypto to NGN at current exchange rates.

4. **Monitor Transactions:**
   - Use the "💰 Transactions" option to view all your deposit and payout activities.

5. **Support & Assistance:**
   - Access detailed support tutorials anytime from the "ℹ️ Support" section.

**🔒 Security:**
Your funds are secure with us. We utilize industry-standard encryption and security protocols to ensure your assets and information remain safe.

**💬 Need Help?**
Visit the support section or contact our support team at [@your_support_username](https://t.me/your_support_username) for any assistance.
`,
  transaction_guide: `
**💰 Transaction Not Received?**

If you haven't received your transaction, follow these steps to troubleshoot:

1. **Verify Wallet Address:**
   - Ensure that the sender used the correct wallet address provided by DirectPay.

2. **Check Bank Linking:**
   - Make sure your bank account is correctly linked.
   - If not linked, go to "⚙️ Settings" > "🏦 Link Bank Account" to add your bank details.

3. **Monitor Transaction Status:**
   - Use the "💰 Transactions" section to check the status of your deposit.
   - Pending status indicates that the deposit is being processed.

4. **Wait for Confirmation:**
   - Deposits might take a few minutes to reflect depending on the network congestion.

5. **Contact Support:**
   - If the issue persists after following the above steps, reach out to our support team at [@your_support_username](https://t.me/your_support_username) with your transaction details for further assistance.
`,
  link_bank_tutorial: `
**🏦 How to Edit Your Bank Account**

*Editing an Existing Bank Account:*

1. **Navigate to Bank Editing:**
   - Click on "⚙️ Settings" > "✏️ Edit Linked Bank Details" from the main menu.

2. **Authenticate with PIN:**
   - Enter your 4-digit PIN to verify your identity.

3. **Provide New Bank Details:**
   - Enter the updated bank name or account number as required.

4. **Verify Changes:**
   - Confirm the updated account holder name.

5. **Completion:**
   - Your bank account details have been updated successfully.
`,
};

/**
 * Handles the 'Learn About Base' command.
 */
bot.hears(/📘\s*Learn About Base/i, async (ctx) => {
  try {
    await sendBaseContent(ctx, 0, true);
  } catch (error) {
    logger.error(`Error handling 'Learn About Base': ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred while fetching information about Base.');
  }
});

/**
 * Base content pages.
 */
const baseContent = [
  {
    title: 'Welcome to Base',
    text: 'Base is a secure, low-cost, and developer-friendly Ethereum Layer 2 network. It offers a seamless way to onboard into the world of decentralized applications.',
  },
  {
    title: 'Why Choose Base?',
    text: '- **Lower Fees**: Significantly reduced transaction costs.\n- **Faster Transactions**: Swift confirmation times.\n- **Secure**: Built on Ethereum’s robust security.\n- **Developer-Friendly**: Compatible with EVM tools and infrastructure.',
  },
  {
    title: 'Getting Started',
    text: 'To start using Base, you can bridge your assets from Ethereum to Base using the official bridge at [Bridge Assets to Base](https://base.org/bridge).',
  },
  {
    title: 'Learn More',
    text: 'Visit the official documentation at [Base Documentation](https://docs.base.org) for in-depth guides and resources.',
  },
];

/**
 * Sends content pages for 'Learn About Base'.
 * @param {TelegrafContext} ctx - Telegraf context.
 * @param {number} index - Current page index.
 * @param {boolean} isNew - Whether it's a new message or an edit.
 */
async function sendBaseContent(ctx, index, isNew = true) {
  try {
    const content = baseContent[index];
    const totalPages = baseContent.length;

    const navigationButtons = [];

    if (index > 0) {
      navigationButtons.push(Markup.button.callback('⬅️ Back', `base_page_${index - 1}`));
    }

    if (index < totalPages - 1) {
      navigationButtons.push(Markup.button.callback('Next ➡️', `base_page_${index + 1}`));
    }

    navigationButtons.push(Markup.button.callback('🔚 Exit', 'exit_base'));

    const inlineKeyboard = Markup.inlineKeyboard([navigationButtons]);

    if (isNew) {
      const sentMessage = await ctx.replyWithMarkdown(`**${content.title}**\n\n${content.text}`, inlineKeyboard);
      // Store the message ID in session
      ctx.scene.state.baseMessageId = sentMessage.message_id;
    } else {
      try {
        await ctx.editMessageText(`**${content.title}**\n\n${content.text}`, {
          parse_mode: 'Markdown',
          reply_markup: inlineKeyboard.reply_markup,
        });
      } catch (error) {
        // If editing message fails, send a new message and update session
        const sentMessage = await ctx.replyWithMarkdown(`**${content.title}**\n\n${content.text}`, inlineKeyboard);
        ctx.scene.state.baseMessageId = sentMessage.message_id;
      }
    }
  } catch (error) {
    logger.error(`Error in sendBaseContent: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred while fetching information about Base.');
  }
}

// Base Content Pagination
bot.action(/base_page_(\d+)/, async (ctx) => {
  try {
    const index = parseInt(ctx.match[1], 10);
    if (isNaN(index) || index < 0 || index >= baseContent.length) {
      return ctx.answerCbQuery('⚠️ Invalid page number.', { show_alert: true });
    }
    await sendBaseContent(ctx, index, false);
    ctx.answerCbQuery(); // Acknowledge the callback
  } catch (error) {
    logger.error(`Error handling base_page_${ctx.match[1]}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred. Please try again later.');
    ctx.answerCbQuery();
  }
});

// Exit Base Content
bot.action('exit_base', async (ctx) => {
  try {
    // Delete the message and clear session
    if (ctx.scene.state.baseMessageId) {
      await ctx.deleteMessage(ctx.scene.state.baseMessageId).catch(() => {});
      ctx.scene.state.baseMessageId = null;
    }
    await ctx.replyWithMarkdown('Thank you for learning about Base!');
    ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error handling exit_base: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred. Please try again.');
  }
});

// =================== Support Handlers ===================
bot.hears(/ℹ️\s*Support/i, async (ctx) => {
  try {
    await ctx.replyWithMarkdown('🛠️ *Support Section*\n\nSelect an option below:', Markup.inlineKeyboard([
      [Markup.button.callback('❓ How It Works', 'support_how_it_works')],
      [Markup.button.callback('⚠️ Transaction Not Received', 'support_not_received')],
      [Markup.button.callback('💬 Contact Support', 'support_contact')],
    ]));
  } catch (error) {
    logger.error(`Error handling Support for user ${ctx.from.id}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred. Please try again later.');
  }
});

// Support Actions
bot.action('support_how_it_works', async (ctx) => {
  try {
    await ctx.replyWithMarkdown(detailedTutorials.how_it_works);
    ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error handling support_how_it_works: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred. Please try again later.');
  }
});

bot.action('support_not_received', async (ctx) => {
  try {
    await ctx.replyWithMarkdown(detailedTutorials.transaction_guide);
    ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error handling support_not_received: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred. Please try again later.');
  }
});

bot.action('support_contact', async (ctx) => {
  try {
    await ctx.replyWithMarkdown('You can contact our support team at [@your_support_username](https://t.me/your_support_username).');
    ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error handling support_contact: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred. Please try again later.');
  }
});

// =================== Transactions Handler ===================
bot.hears(/💰\s*Transactions/i, async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    const userState = await getUserState(userId);
    
    if (userState.wallets.length === 0) {
      return ctx.replyWithMarkdown('❌ You have no wallets. Please generate a wallet first using the "💼 Generate Wallet" option.');
    }

    // Implement Pagination
    const pageSize = 5; // Number of transactions per page
    const totalPages = Math.ceil(userState.wallets.length / pageSize) || 1;
    ctx.scene.state.transactionsPage = 1; // Initialize to first page

    const generateTransactionPage = (page) => {
      const start = (page - 1) * pageSize;
      const end = start + pageSize;
      const transactions = userState.wallets.slice(start, end);

      let message = `💰 *Your Transactions* (Page ${page}/${totalPages}):\n\n`;
      transactions.forEach((tx, index) => {
        message += `*Transaction ${start + index + 1}:*\n`;
        message += `• *Reference ID:* \`${tx.referenceId || 'N/A'}\`\n`;
        message += `• *Amount:* ${tx.amount || 'N/A'} ${tx.asset || 'N/A'}\n`;
        message += `• *Status:* ${tx.status || 'Pending'}\n`;
        message += `• *Date:* ${tx.timestamp ? new Date(tx.timestamp).toLocaleString() : 'N/A'}\n`;
        message += `• *Chain:* ${tx.chain || 'N/A'}\n`;
        message += `• *Details:* [View on Explorer](https://polygonscan.com/tx/${tx.transactionHash || 'N/A'})\n\n`; // Detailed Transaction View
      });

      // Add Key Metrics
      let totalDeposited = 0;
      let totalWithdrawn = 0;
      userState.wallets.forEach(wallet => {
        wallet.transactions?.forEach(tx => {
          if (tx.status === 'Completed') {
            totalDeposited += parseFloat(tx.amount) || 0;
            totalWithdrawn += parseFloat(tx.payout) || 0;
          }
        });
      });

      message += `*Key Metrics:*\n`;
      message += `• *Total Deposited:* ${totalDeposited} ${userState.wallets[0].supportedAssets[0] || 'N/A'}\n`;
      message += `• *Total Withdrawn:* ₦${totalWithdrawn}\n`;
      message += `• *Number of Active Wallets:* ${userState.wallets.length}\n`;

      const navigationButtons = [];

      if (page > 1) {
        navigationButtons.push(Markup.button.callback('⬅️ Previous', `transaction_page_${page - 1}`));
      }
      if (page < totalPages) {
        navigationButtons.push(Markup.button.callback('Next ➡️', `transaction_page_${page + 1}`));
      }
      navigationButtons.push(Markup.button.callback('🔄 Refresh', `transaction_page_${page}`));

      const inlineKeyboard = Markup.inlineKeyboard([navigationButtons]);

      return { message, inlineKeyboard };
    };

    const { message, inlineKeyboard } = generateTransactionPage(ctx.scene.state.transactionsPage);
    await ctx.replyWithMarkdown(message, inlineKeyboard);
  } catch (error) {
    logger.error(`Error fetching transactions for user ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ Unable to fetch transactions. Please try again later.');
  }
});

// Handle Transaction Page Navigation
bot.action(/transaction_page_(\d+)/, async (ctx) => {
  try {
    const userId = ctx.from.id.toString();
    const requestedPage = parseInt(ctx.match[1], 10);

    const userState = await getUserState(userId);
    const pageSize = 5;
    const totalPages = Math.ceil(userState.wallets.length / pageSize) || 1;

    if (requestedPage < 1 || requestedPage > totalPages) {
      return ctx.answerCbQuery('⚠️ Invalid page number.', { show_alert: true });
    }

    ctx.scene.state.transactionsPage = requestedPage;

    const start = (requestedPage - 1) * pageSize;
    const end = start + pageSize;
    const transactions = userState.wallets.slice(start, end);

    let message = `💰 *Your Transactions* (Page ${requestedPage}/${totalPages}):\n\n`;
    transactions.forEach((tx, index) => {
      message += `*Transaction ${start + index + 1}:*\n`;
      message += `• *Reference ID:* \`${tx.referenceId || 'N/A'}\`\n`;
      message += `• *Amount:* ${tx.amount || 'N/A'} ${tx.asset || 'N/A'}\n`;
      message += `• *Status:* ${tx.status || 'Pending'}\n`;
      message += `• *Date:* ${tx.timestamp ? new Date(tx.timestamp).toLocaleString() : 'N/A'}\n`;
      message += `• *Chain:* ${tx.chain || 'N/A'}\n`;
      message += `• *Details:* [View on Explorer](https://polygonscan.com/tx/${tx.transactionHash || 'N/A'})\n\n`; // Detailed Transaction View
    });

    // Add Key Metrics
    let totalDeposited = 0;
    let totalWithdrawn = 0;
    userState.wallets.forEach(wallet => {
      wallet.transactions?.forEach(tx => {
        if (tx.status === 'Completed') {
          totalDeposited += parseFloat(tx.amount) || 0;
          totalWithdrawn += parseFloat(tx.payout) || 0;
        }
      });
    });

    message += `*Key Metrics:*\n`;
    message += `• *Total Deposited:* ${totalDeposited} ${userState.wallets[0].supportedAssets[0] || 'N/A'}\n`;
    message += `• *Total Withdrawn:* ₦${totalWithdrawn}\n`;
    message += `• *Number of Active Wallets:* ${userState.wallets.length}\n`;

    const navigationButtons = [];

    if (requestedPage > 1) {
      navigationButtons.push(Markup.button.callback('⬅️ Previous', `transaction_page_${requestedPage - 1}`));
    }
    if (requestedPage < totalPages) {
      navigationButtons.push(Markup.button.callback('Next ➡️', `transaction_page_${requestedPage + 1}`));
    }
    navigationButtons.push(Markup.button.callback('🔄 Refresh', `transaction_page_${requestedPage}`));

    const inlineKeyboard = Markup.inlineKeyboard([navigationButtons]);

    await ctx.editMessageText(message, { parse_mode: 'Markdown', reply_markup: inlineKeyboard.reply_markup });
    ctx.answerCbQuery(); // Acknowledge the callback
  } catch (error) {
    logger.error(`Error navigating transaction pages for user ${ctx.from.id}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred while navigating transactions. Please try again later.');
    ctx.answerCbQuery();
  }
});

// =================== Settings Menu Navigation ===================
/**
 * Navigates the user back to the main menu from settings.
 */
bot.action('settings_back_main', async (ctx) => {
  try {
    await greetUser(ctx);
    ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error navigating back to main menu from settings: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred. Please try again.');
    ctx.answerCbQuery();
  }
});

// =================== Settings Menu Actions ===================
bot.action('settings_generate_wallet', async (ctx) => {
  try {
    await ctx.scene.leave();
    await ctx.reply('💼 Generating a new wallet...');
    await ctx.scene.enter('bank_linking_scene');
    ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error in settings_generate_wallet: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred. Please try again.');
    ctx.answerCbQuery();
  }
});

// =================== Admin Panel ===================
// Already handled above

// =================== Support Handlers ===================
// Already handled above

// =================== Transactions Handler ===================
// Already handled above

// =================== Learn About Base Handler ===================
// Already handled above

// =================== Current Rates Handler ===================
bot.hears(/📈\s*View Current Rates/i, async (ctx) => {
  try {
    let ratesMessage = '*📈 Current Exchange Rates:*\n\n';
    for (const [asset, rate] of Object.entries(exchangeRates)) {
      ratesMessage += `• *${asset}*: ₦${rate}\n`;
    }
    ratesMessage += `\n*These rates are updated every 5 minutes.*`;
    await ctx.replyWithMarkdown(ratesMessage);
  } catch (error) {
    logger.error(`Error handling View Current Rates: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred while fetching exchange rates.');
  }
});

// =================== Final Registration and Server Start ===================
// Ensure all scenes are properly registered before starting the server
// (Scenes are already registered above)

// =================== Webhook Handlers ===================

// =================== Blockradar Webhook Handler ===================
app.post(WEBHOOK_BLOCKRADAR_PATH, bodyParser.json(), async (req, res) => {
  try {
    const event = req.body;
    if (!event) {
      logger.error('No event data found in Blockradar webhook.');
      return res.status(400).send('No event data found.');
    }

    logger.info(`Received Blockradar webhook: ${JSON.stringify(event)}`);
    fs.appendFileSync(path.join(__dirname, 'webhook_logs.txt'), `${new Date().toISOString()} - ${JSON.stringify(event, null, 2)}\n`);

    // Extract common event data
    const eventType = event.event || 'Unknown Event';
    const walletAddress = event.data?.recipientAddress || 'N/A';
    const amount = parseFloat(event.data?.amount) || 0;
    const asset = event.data?.asset?.symbol || 'N/A';
    const transactionHash = event.data?.hash || 'N/A';
    const chainRaw = event.data?.blockchain?.name || 'N/A';
    const senderAddress = event.data?.senderAddress || 'N/A'; 

    // Normalize and map the chain name for ease
    const chainKey = chainMapping[chainRaw.toLowerCase()];
    if (!chainKey) {
      logger.error(`Unknown chain received in webhook: ${chainRaw}`);
      // Notify admin about the unmatched wallet
      await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `⚠️ Received deposit on unknown chain: \`${chainRaw}\``);
      return res.status(400).send('Unknown chain.');
    }

    const chain = chainKey;

    if (eventType === 'deposit.success') { // Handle 'deposit.success' event
      if (walletAddress === 'N/A') {
        logger.error('Webhook missing wallet address.');
        return res.status(400).send('Missing wallet address.');
      }

      // DUPLICATE TX CHECK TO AVOID MULTI PAYMENT ORDER CREATION FOR SINGLE TX
      // Check if a transaction with the same hash already exists
      const existingTxSnapshot = await db.collection('transactions').where('transactionHash', '==', transactionHash).get();
      if (!existingTxSnapshot.empty) {
        logger.info(`Transaction with hash ${transactionHash} already exists. Skipping.`);
        return res.status(200).send('OK');
      }
      // **Duplicate Check End**

      // Find user by wallet address
      const usersSnapshot = await db.collection('users').where('walletAddresses', 'array-contains', walletAddress).get();
      if (usersSnapshot.empty) {
        logger.warn(`No user found for wallet ${walletAddress}`);
        // Notify admin about the unmatched wallet
        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `⚠️ No user found for wallet address: \`${walletAddress}\``);
        return res.status(200).send('OK');
      }

      const userDoc = usersSnapshot.docs[0];
      const userId = userDoc.id;
      const userState = userDoc.data();
      const wallet = userState.wallets.find((w) => w.address === walletAddress);

      // Check if Wallet has Linked Bank
      if (!wallet || !wallet.bank) {
        await bot.telegram.sendMessage(userId, `💰 *Deposit Received:* ${amount} ${asset} on ${chainRaw}.\n\nPlease link a bank account to receive your payout securely.`, { parse_mode: 'Markdown' });
        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `⚠️ User ${userId} has received a deposit but hasn't linked a bank account.`, { parse_mode: 'Markdown' });
        return res.status(200).send('OK');
      }

      // Only support USDC and USDT
      if (!['USDC', 'USDT'].includes(asset)) {
        await bot.telegram.sendMessage(userId, `⚠️ *Unsupported Asset Deposited:* ${asset}.\n\nCurrently, only *USDC* and *USDT* are supported. Please contact support if you believe this is an error.`, { parse_mode: 'Markdown' });
        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `⚠️ User ${userId} deposited unsupported asset: ${asset}.`, { parse_mode: 'Markdown' });
        return res.status(200).send('OK');
      }

      // Get the latest exchange rate (ensure exchangeRates are updated dynamically)
      const rate = exchangeRates[asset];
      if (!rate) {
        throw new Error(`Exchange rate for ${asset} not available.`);
      }

      // Calculate the NGN amount based on the current exchange rate
      const ngnAmount = calculatePayout(asset, amount);

      const referenceId = generateReferenceId();
      const bankName = wallet.bank.bankName || 'N/A';
      const bankAccount = wallet.bank.accountNumber || 'N/A';
      const accountName = wallet.bank.accountName || 'Valued User';

      // Fetch the user's first name
      const userFirstName = userState.firstName || 'Valued User';

      // Create Transaction Document with Status 'Processing' and store messageId as null at first
      const transactionRef = await db.collection('transactions').add({
        userId,
        walletAddress,
        chain: chainRaw,
        amount: amount,
        asset: asset,
        transactionHash: transactionHash,
        referenceId: referenceId,
        bankDetails: wallet.bank,
        payout: ngnAmount, // Store NGN payout
        timestamp: new Date().toISOString(),
        status: 'Processing',
        paycrestOrderId: '', // To be updated upon Paycrest order creation
        messageId: null, // To be set after sending the pending message
        firstName: userFirstName // Added firstName here
      });

      // Send Detailed Pending Message to User
      const pendingMessage = await bot.telegram.sendMessage(userId,
        `🎉 *Deposit Received!*\n\n` +
        `*Reference ID:* \`${referenceId}\`\n` +
        `*Amount Deposited:* ${amount} ${asset}\n` +
        `*Exchange Rate:* ₦${rate} per ${asset}\n` + 
        `*Network:* ${chainRaw}\n\n` +
        `🔄 *Your order has begun processing!* ⏳\n\n` +
        `We are converting your crypto to NGN at the current exchange rate of ₦${rate} per ${asset}. Your cash will be credited to your linked bank account shortly.\n\n` +
        `Thank you for using *DirectPay*!`,
        { parse_mode: 'Markdown' }
      );

      // Update the transaction document with message_id
      await transactionRef.update({
        messageId: pendingMessage.message_id
      });

      // Notify admin with detailed deposit information
      const adminDepositMessage = `⚡️ *New Deposit Received*\n\n` +
        `*User:* ${userFirstName} (ID: ${userId})\n` +
        `*Amount Deposited:* ${amount} ${asset}\n` +
        `*Exchange Rate:* ₦${rate} per ${asset}\n` +
        `*Amount to be Paid:* ₦${ngnAmount}\n` +
        `*Time:* ${new Date().toLocaleString()}\n` +
        `*Bank Details:*\n` +
        `  - *Account Name:* ${accountName}\n` +
        `  - *Bank Name:* ${bankName}\n` +
        `  - *Account Number:* ****${bankAccount.slice(-4)}\n` +
        `*Chain:* ${chainRaw}\n` +
        `*Transaction Hash:* \`${transactionHash}\`\n` +
        `*Reference ID:* ${referenceId}\n`;
      await bot.telegram.sendMessage(PERSONAL_CHAT_ID, adminDepositMessage, { parse_mode: 'Markdown' });

      // Integrate Paycrest to off-ramp automatically
      const paycrestMapping = mapToPaycrest(asset, chainRaw);
      if (!paycrestMapping) {
        logger.error('No Paycrest mapping for this asset/chain.');
        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `⚠️ No Paycrest mapping found for asset ${asset} on chain ${chainRaw}.`);
        return res.status(200).send('OK');
      }

      // Create Paycrest order with returnAddress as senderAddress
      let paycrestOrder;
      try {
        paycrestOrder = await createPaycrestOrder(userId, amount, asset, chainRaw, wallet.bank, senderAddress); 
        await transactionRef.update({ paycrestOrderId: paycrestOrder.id });
      } catch (err) {
        logger.error(`Error creating Paycrest order for user ${userId}: ${err.message}`);
        // Notify admin about the failure
        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ Error creating Paycrest order for user ${userId}: ${err.message}`, { parse_mode: 'Markdown' });
        // Update transaction status to 'Failed'
        await transactionRef.update({ status: 'Failed' });
        // Update user's pending message to indicate failure
        const failureMessage = `Hello ${userFirstName},\n\n` +
          `⚠️ *Your DirectPay order has failed to process.*\n\n` +
          `Please contact our support team for assistance.`;
        await bot.telegram.editMessageText(userId, pendingMessage.message_id, null, failureMessage, { parse_mode: 'Markdown' });
        return res.status(500).send('Paycrest order error');
      }

      const receiveAddress = paycrestOrder.receiveAddress;

      // Withdraw from Blockradar to Paycrest receiveAddress
      let blockradarAssetId;
      switch (asset) {
        case 'USDC':
          blockradarAssetId = chains[chain].assets['USDC'];
          break;
        case 'USDT':
          blockradarAssetId = chains[chain].assets['USDT'];
          break;
        default:
          throw new Error(`Unsupported asset: ${asset}`);
      }

      try {
        await withdrawFromBlockradar(chainRaw, blockradarAssetId, receiveAddress, amount, paycrestOrder.id, { userId, originalTxHash: transactionHash });
      } catch (err) {
        logger.error(`Error withdrawing from Blockradar for user ${userId}: ${err.response ? err.response.data.message : err.message}`);
        // Notify admin about this failure
        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ Error withdrawing from Blockradar for user ${userId}: ${err.response ? err.response.data.message : err.message}`, { parse_mode: 'Markdown' });
        // Update transaction status to 'Failed'
        await transactionRef.update({ status: 'Failed' });
        // Update user's pending message to indicate failure
        const failureMessage = `Hello ${userFirstName},\n\n` +
          `⚠️ *Your DirectPay order has failed to process.*\n\n` +
          `Please contact our support team for assistance.`;
        await bot.telegram.editMessageText(userId, pendingMessage.message_id, null, failureMessage, { parse_mode: 'Markdown' });
        return res.status(500).send('Blockradar withdrawal error');
      }

      // Update transaction status to 'Pending'
      await db.collection('transactions').doc(transactionRef.id).update({ status: 'Pending' });

      logger.info(`Transaction stored for user ${userId}: Reference ID ${paycrestOrder.id}`);

      res.status(200).send('OK');
    }
  } catch (error) {
    logger.error(`Error processing Blockradar webhook: ${error.message}`);
    res.status(500).send('Error processing webhook');
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ Error processing Blockradar webhook: ${error.message}`);
  }
});

// =================== Paycrest Webhook Handler ===================
app.post(WEBHOOK_PAYCREST_PATH, bodyParser.raw({ type: 'application/json' }), async (req, res) => {
  const signature = req.headers['x-paycrest-signature'];
  const rawBody = req.body; // Buffer

  if (!signature) {
    logger.error('No Paycrest signature found in headers.');
    return res.status(400).send('Signature missing.');
  }

  if (!verifyPaycrestSignature(rawBody, signature, PAYCREST_CLIENT_SECRET)) {
    logger.error('Invalid Paycrest signature.');
    return res.status(401).send('Invalid signature.');
  }

  let parsedBody;
  try {
    parsedBody = JSON.parse(rawBody.toString());
  } catch (error) {
    logger.error(`Failed to parse Paycrest webhook body: ${error.message}`);
    return res.status(400).send('Invalid JSON.');
  }

  const event = parsedBody.event;
  const data = parsedBody.data;

  // Log the received event for debugging purposes
  logger.info(`Received Paycrest event: ${event}`);

  try {
    // Extract common data
    const orderId = data.id;
    const status = data.status; 
    const amountPaid = parseFloat(data.amountPaid) || 0;
    const reference = data.reference;
    const returnAddress = data.returnAddress;
    const txHash = data.txHash;

    // Explorer links
    function getExplorerLink(network, txHash) {
      const explorers = {
        'Base': `https://basescan.org/tx/${txHash}`,
        'Polygon': `https://polygonscan.com/tx/${txHash}`,
        'BNB Smart Chain': `https://bscscan.com/tx/${txHash}`,
      };
      return explorers[network] || 'N/A';
    }

    // Fetch the transaction by Paycrest order ID
    const txSnapshot = await db.collection('transactions').where('paycrestOrderId', '==', orderId).limit(1).get();

    if (txSnapshot.empty) {
      logger.error(`No transaction found for Paycrest orderId: ${orderId}`);
      await bot.telegram.sendMessage(
        PERSONAL_CHAT_ID, 
        `❗️ No transaction found for Paycrest orderId: \`${orderId}\``, 
        { parse_mode: 'Markdown' }
      );
      return res.status(200).send('OK');
    }

    const txDoc = txSnapshot.docs[0];
    const txData = txDoc.data();
    const userId = txData.userId;
    const userFirstName = txData.firstName || 'Valued User';

    // Switch based on the 'event' field instead of 'status'
    switch (event) {
      case 'payment_order.pending':
        await bot.telegram.sendMessage(
          userId,
          `🔄 *Your DirectPay order is pending processing.*\n\n` +
          `Reference ID: \`${txData.referenceId}\`\n` +
          `Amount: ${txData.amount} ${txData.asset}\n` +
          `Network: ${txData.chain}\n\n` +
          `We are currently processing your order. Please wait for further updates.`,
          { parse_mode: 'Markdown' }
        );

        // Log to admin
        await bot.telegram.sendMessage(
          PERSONAL_CHAT_ID, 
          `🔄 *Payment Order Pending*\n\n` +
          `*User:* ${userFirstName} (ID: ${userId})\n` +
          `*Reference ID:* ${reference}\n` +
          `*Amount Paid:* ₦${amountPaid}\n`, 
          { parse_mode: 'Markdown' }
        );
        break;

      case 'payment_order.settled':
        const amountEarnedNaira = calculateAmountEarnedInNaira(txData.asset, txData.amount);
        await bot.telegram.sendMessage(
          userId, 
          `🎉 *Your DirectPay transaction is complete*\n\n` +
          `Hello ${userFirstName},\n\n` +
          `We’ve converted the ${txData.amount} ${txData.asset} you deposited and successfully sent ₦${amountEarnedNaira} to your linked account.\n\n` +
          `*Transaction Details:*\n\n` +
          `• *Crypto Amount:* ${txData.amount} ${txData.asset}\n` +
          `• *Cash Amount:* ₦${amountEarnedNaira}\n` +
          `• *Network:* ${txData.chain}\n` +
          `• *Date:* ${new Date(txData.timestamp).toLocaleString()}\n\n` + 
          `Thank you for using *DirectPay*!`,
          { parse_mode: 'Markdown' }
        );

        // **Remove the previous rating prompt and send a new vertical rating menu**
        // Delete the previous message (if any)
        if (txData.messageId) {
          try {
            await bot.telegram.deleteMessage(userId, txData.messageId);
          } catch (error) {
            logger.error(`Error deleting previous message for user ${userId}: ${error.message}`);
          }
        }

        // Send vertical rating menu
        await bot.telegram.sendMessage(
          userId,
          '⭐️ *How would you rate our service?*',
          Markup.inlineKeyboard([
            [Markup.button.callback('⭐️', 'rate_1')],
            [Markup.button.callback('⭐️⭐️', 'rate_2')],
            [Markup.button.callback('⭐️⭐️⭐️', 'rate_3')],
            [Markup.button.callback('⭐️⭐️⭐️⭐️', 'rate_4')],
            [Markup.button.callback('⭐️⭐️⭐️⭐️⭐️', 'rate_5')],
          ])
        );

        // Update transaction status in Firestore
        await db.collection('transactions').doc(txDoc.id).update({ status: 'Completed' });

        // Log to admin
        await bot.telegram.sendMessage(
          PERSONAL_CHAT_ID, 
          `✅ *Payment Order Settled*\n\n` +
          `*User:* ${userFirstName} (ID: ${userId})\n` +
          `*Reference ID:* ${reference}\n` +
          `*Amount Paid:* ₦${amountPaid}\n`, 
          { parse_mode: 'Markdown' }
        );
        break;

      case 'payment_order.expired':
        await bot.telegram.sendMessage(
          userId, 
          `⚠️ *Your DirectPay order has expired.*\n\n` +
          `Hello ${userFirstName},\n\n` +
          `We regret to inform you that your DirectPay order has expired.\n\n` +
          `*Reason:* We experienced issues while processing your order. Rest assured, the funds have been returned to your original payment method.\n\n` +
          `If you believe this is a mistake or need further assistance, please don't hesitate to contact our support team.\n\n` +
          `Thank you for your understanding.`,
          { parse_mode: 'Markdown' }
        );

        // Update transaction status in Firestore
        await db.collection('transactions').doc(txDoc.id).update({ status: 'Expired' });

        // Log to admin
        await bot.telegram.sendMessage(
          PERSONAL_CHAT_ID, 
          `⏰ *Payment Order Expired*\n\n` +
          `*User:* ${userFirstName} (ID: ${userId})\n` +
          `*Reference ID:* ${reference}\n`, 
          { parse_mode: 'Markdown' }
        );
        break;

      case 'payment_order.refunded':
        await bot.telegram.sendMessage(
          userId, 
          `❌ *Your DirectPay Order Has Been Refunded*\n\n` +
          `Hello ${userFirstName},\n\n` +
          `We regret to inform you that your DirectPay order has been refunded.\n\n` +
          `*Reason:* We encountered issues while processing your order. Rest assured, the funds have been returned to your original payment method.\n\n` +
          `*Transaction Details:*\n` +
          `• *Refund Amount:* ₦${txData.amount || 'N/A'}\n` +
          `• *Date:* ${new Date(txData.timestamp).toLocaleString()}\n` +
          `• *Transaction Hash:* \`${txHash}\`\n` +
          `• *Explorer Link:* (${getExplorerLink(txData.chain, txHash)})\n\n` +
          `If you believe this is a mistake or need further assistance, please don't hesitate to contact our support team.\n\n` +
          `Thank you for your understanding.`,
          { parse_mode: 'Markdown' }
        );
        break;

      default:
        logger.info(`Unhandled Paycrest event type: ${event}`);
    }

    res.status(200).send('OK');
  } catch (error) {
    logger.error(`Error processing Paycrest webhook: ${error.message}`);
    await bot.telegram.sendMessage(
      PERSONAL_CHAT_ID, 
      `❗️ Error processing Paycrest webhook: ${error.message}`, 
      { parse_mode: 'Markdown' }
    );
    res.status(500).send('Error');
  }
});

// =================== Telegram Webhook Handler ===================
app.post(WEBHOOK_PATH, bodyParser.json(), (req, res) => {
  if (!req.body) {
    logger.error('No body found in Telegram webhook request.');
    return res.status(400).send('No body found.');
  }

  logger.info(`Received Telegram update: ${JSON.stringify(req.body, null, 2)}`); // Debugging

  bot.handleUpdate(req.body, res);
});

// =================== Final Server Start ===================
// Start Express Server
app.listen(PORT, () => {
  logger.info(`Webhook server running on port ${PORT}`);
});

// =================== Shutdown Handlers ===================
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
