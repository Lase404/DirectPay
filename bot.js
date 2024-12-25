// =================== Required Imports ===================
const { Telegraf, Scenes, session, Markup } = require('telegraf');
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const Bottleneck = require('bottleneck'); 
const fs = require('fs');
const path = require('path');
const winston = require('winston');
const admin = require('firebase-admin');
const Queue = require('bull');
require('dotenv').config();

// =================== Logger Setup ===================
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'bot-error.log', level: 'error' }),
    new winston.transports.File({ filename: 'bot-combined.log' }),
  ],
});

// If not in production, also log to the console
if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({
    format: winston.format.simple(),
  }));
}

// =================== Environment Variables ===================
const {
  BOT_TOKEN,
  TELEGRAM_WEBHOOK_URL,
  TELEGRAM_WEBHOOK_PATH,
  PAYSTACK_API_KEY, // Paystack API Key
  PAYCREST_API_KEY,
  PAYCREST_CLIENT_SECRET,
  PAYCREST_RETURN_ADDRESS,
  BLOCKRADAR_API_KEY,
  PERSONAL_CHAT_ID, // Admin Telegram ID
  ADMIN_IDS, // Comma-separated list of Admin IDs
  MAX_WALLETS = 5, // Default max wallets per user
} = process.env;

// Validate essential environment variables
if (!BOT_TOKEN || !TELEGRAM_WEBHOOK_URL || !PAYSTACK_API_KEY || !PAYCREST_API_KEY || !PAYCREST_CLIENT_SECRET || !PAYCREST_RETURN_ADDRESS || !BLOCKRADAR_API_KEY || !PERSONAL_CHAT_ID || !ADMIN_IDS) {
  logger.error('One or more essential environment variables are missing. Please check your .env file.');
  process.exit(1);
}

// =================== Initialize Telegraf Bot ===================
const bot = new Telegraf(BOT_TOKEN);

// =================== Initialize Express App ===================
const app = express();

// Middleware to parse JSON bodies
app.use(express.json());

// =================== Firebase Initialization ===================
const serviceAccount = require('./directpay.json'); // Ensure this path is correct and the file is secured

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

// =================== Background Job Queue Setup ===================
const webhookQueue = new Queue('webhook-processing', {
  redis: { host: '127.0.0.1', port: 6379 }, // Adjust as per your Redis setup
});

const withdrawalQueue = new Queue('withdrawals', {
  redis: { host: '127.0.0.1', port: 6379 }, // Adjust as per your Redis setup
});

// Process webhook jobs
webhookQueue.process(async (job) => {
  const { event } = job.data;
  // Implement your webhook processing logic here
});

// Process withdrawal jobs
withdrawalQueue.process(async (job) => {
  const { userId, amount, asset, chain, bankDetails, originalTxHash } = job.data;

  try {
    // Create Paycrest order
    const paycrestOrder = await createPaycrestOrder(userId, amount, asset, chain, bankDetails);

    // Initiate withdrawal to Paycrest receive address
    const receiveAddress = paycrestOrder.receiveAddress;

    // Determine Blockradar Asset ID
    let blockradarAssetId;
    switch (asset) {
      case 'USDC':
        blockradarAssetId = process.env.BLOCKRADAR_USDC_ASSET_ID || 'YOUR_BLOCKRADAR_USDC_ASSET_ID'; // Ensure this environment variable is set
        break;
      case 'USDT':
        blockradarAssetId = process.env.BLOCKRADAR_USDT_ASSET_ID || 'YOUR_BLOCKRADAR_USDT_ASSET_ID'; // Ensure this environment variable is set
        break;
      default:
        throw new Error(`Unsupported asset: ${asset}`);
    }

    await withdrawFromBlockradar(chain, blockradarAssetId, receiveAddress, amount, paycrestOrder.id, { userId, originalTxHash });

    // Update the deposit record with Paycrest order ID and withdrawal status
    await db.collection('deposits').doc(originalTxHash).update({
      paycrestOrderId: paycrestOrder.id,
      withdrawalStatus: 'initiated',
      withdrawalAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Notify admin about the successful withdrawal
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `✅ Withdrawal initiated for user ${userId}.\n\n` +
      `*Reference ID:* ${paycrestOrder.id}\n` +
      `*Amount:* ${amount} ${asset}\n` +
      `*Network:* ${chain}\n` +
      `*Withdrawal Address:* ${receiveAddress}\n`, { parse_mode: 'Markdown' });

    return Promise.resolve();
  } catch (error) {
    logger.error(`Error processing withdrawal job for transactionHash ${job.data.originalTxHash}: ${error.message}`);
    // Update the deposit record with failure status
    await db.collection('deposits').doc(originalTxHash).update({
      withdrawalStatus: 'failed',
      withdrawalError: error.message,
      status: 'failed',
      sweptAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    // Notify admin about the failure
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ Failed to initiate withdrawal for user associated with transactionHash ${originalTxHash}: ${error.message}`);
    return Promise.reject(error);
  }
});

// =================== Helper Data ===================

// Complete Bank List with Paycrest Institution Codes
const bankList = [
  { name: 'Access Bank', code: '044', aliases: ['access', 'access bank', 'accessb', 'access bank nigeria'], paycrestInstitutionCode: 'ABNGNGLA' },
  { name: 'Diamond Bank', code: '054', aliases: ['diamond', 'diamond bank', 'diamondb', 'diamond bank nigeria'], paycrestInstitutionCode: 'DBLNNGLA' },
  { name: 'Ecobank Nigeria', code: '050', aliases: ['ecobank', 'ecobank nigeria', 'eco', 'ecobanknigeria'], paycrestInstitutionCode: 'ECOGNGNG' },
  { name: 'Fidelity Bank', code: '070', aliases: ['fidelity', 'fidelity bank', 'fidelityb', 'fidelity bank nigeria'], paycrestInstitutionCode: 'FIDNGNGLA' },
  { name: 'First Bank of Nigeria', code: '011', aliases: ['first bank', 'first bank nigeria', 'first bank of nigeria', 'firstb'], paycrestInstitutionCode: 'FBNNGNGLA' },
  { name: 'First City Monument Bank', code: '214', aliases: ['fcmb', 'first city monument bank', 'first city bank', 'fcmbnigeria'], paycrestInstitutionCode: 'FCMGNGGLA' },
  { name: 'Guaranty Trust Bank', code: '058', aliases: ['gtbank', 'guaranty trust bank', 'gtb', 'gtbank nigeria'], paycrestInstitutionCode: 'GTBNGNGLA' },
  { name: 'Heritage Bank', code: '030', aliases: ['heritage', 'heritage bank', 'heritageb', 'heritage bank nigeria'], paycrestInstitutionCode: 'HTBNGNGLA' },
  { name: 'Keystone Bank', code: '082', aliases: ['keystone', 'keystone bank', 'keystoneb', 'keystone bank nigeria'], paycrestInstitutionCode: 'KSTNGNGLA' },
  { name: 'Providus Bank', code: '101', aliases: ['providus', 'providus bank', 'providusb', 'providus bank nigeria'], paycrestInstitutionCode: 'PRVDNGGLA' },
  { name: 'Polaris Bank', code: '076', aliases: ['polaris', 'polaris bank', 'polarisb', 'polaris bank nigeria'], paycrestInstitutionCode: 'PLRSNGGLA' },
  { name: 'Stanbic IBTC Bank', code: '221', aliases: ['stanbic ibtc', 'stanbic ibtc bank', 'stanbic', 'ibtc'], paycrestInstitutionCode: 'STBNGNGLA' },
  { name: 'Standard Chartered Bank', code: '068', aliases: ['standard chartered', 'standard chartered bank', 'scb', 'standard chartered nigeria'], paycrestInstitutionCode: 'STDNGNGLA' },
  { name: 'Sterling Bank', code: '232', aliases: ['sterling', 'sterling bank', 'sterlingb', 'sterling bank nigeria'], paycrestInstitutionCode: 'STRLNGNGLA' },
  { name: 'Union Bank of Nigeria', code: '032', aliases: ['union bank', 'union bank nigeria', 'unionb'], paycrestInstitutionCode: 'UNBNGNGLA' },
  { name: 'United Bank for Africa', code: '033', aliases: ['uba', 'united bank africa', 'united bank for africa', 'uba nigeria'], paycrestInstitutionCode: 'UBANGNGLA' },
  { name: 'Unity Bank', code: '215', aliases: ['unity', 'unity bank', 'unityb', 'unity bank nigeria'], paycrestInstitutionCode: 'UNYBNGGLA' },
  { name: 'Wema Bank', code: '035', aliases: ['wema', 'wema bank', 'wemab', 'wema bank nigeria'], paycrestInstitutionCode: 'WEMANGGLA' },
  { name: 'Zenith Bank', code: '057', aliases: ['zenith', 'zenith bank', 'zenithb', 'zenith bank nigeria'], paycrestInstitutionCode: 'ZNBNGNGLA' },
  { name: 'Safe Haven MFB', code: '999994', aliases: ['safe haven', 'safe haven mfb', 'safe haven nigeria'], paycrestInstitutionCode: 'SAHVNGPC' }
  // Add more banks as needed
];

// Define supported chains and their mappings
const chainMapping = {
  'polygon': 'polygon',
  'base': 'base',
  'bnb smart chain': 'bnb-smart-chain',
  // Add other chain mappings as needed
};

const chains = {
  'polygon': { id: 'polygon_wallet_id', supportedAssets: ['USDC', 'USDT'] },
  'base': { id: 'base_wallet_id', supportedAssets: ['USDC', 'USDT'] },
  'bnb-smart-chain': { id: 'bnb_smart_chain_wallet_id', supportedAssets: ['USDC', 'USDT'] },
  // Add other chains as needed
};

// =================== Helper Functions ===================

// Function to fetch exchange rates
async function fetchExchangeRates() {
  try {
    // Example API call to fetch exchange rates
    const response = await axios.get('https://api.exchangerate-api.com/v4/latest/USD'); // Replace with your actual rates API
    const rates = response.data.rates;
    // Assuming you have specific assets to map
    exchangeRates = {
      USDC: rates['USD'], // Example rate
      USDT: rates['USD'], // Example rate
      // Add more assets as needed
    };
    logger.info('Exchange rates updated successfully.');
  } catch (error) {
    logger.error(`Error fetching exchange rates: ${error.message}`);
  }
}

// Initialize exchange rates
let exchangeRates = {};
fetchExchangeRates();

// Function to generate a unique reference ID
function generateReferenceId() {
  return 'ref_' + crypto.randomBytes(8).toString('hex');
}

// Function to calculate NGN payout based on asset amount and exchange rate
function calculatePayout(asset, amount) {
  const rate = exchangeRates[asset];
  if (!rate) {
    throw new Error(`Exchange rate for ${asset} not available.`);
  }
  return rate * amount;
}

// Function to verify if a user is an admin
function isAdmin(userId) {
  const admins = ADMIN_IDS.split(',').map(id => id.trim());
  return admins.includes(userId);
}

// Function to fetch user state from Firestore
async function getUserState(userId) {
  const userDoc = await db.collection('users').doc(userId).get();
  if (!userDoc.exists) {
    // Initialize user state if not exists
    await db.collection('users').doc(userId).set({
      wallets: [],
      walletAddresses: [],
      isActive: false,
      dateJoined: admin.firestore.FieldValue.serverTimestamp(),
      transactionCount: 0,
      // Add other initial states as needed
    });
    return { wallets: [], walletAddresses: [], isActive: false, transactionCount: 0 };
  }
  return userDoc.data();
}

// Function to update user state in Firestore
async function updateUserState(userId, data) {
  await db.collection('users').doc(userId).update(data);
}

// Function to map asset and chain to Paycrest parameters
function mapToPaycrest(asset, chainName) {
  // Define supported assets and their mappings
  const SUPPORTED_ASSETS = ['USDC', 'USDT'];
  
  // Define chain mappings
  const chainMappingLower = {
    'base': 'base',
    'polygon': 'polygon',
    'bnb smart chain': 'bnb-smart-chain',
    // Add other chain mappings as needed
  };
  
  if (!SUPPORTED_ASSETS.includes(asset)) return null;

  let token = asset.toUpperCase(); // 'USDC' or 'USDT'
  let network;
  const chainKey = chainMappingLower[chainName.toLowerCase()];
  if (!chainKey) {
    logger.error(`No mapping found for chain name: ${chainName}`);
    return null;
  }
  if (/polygon/i.test(chainKey)) network = 'polygon';
  else if (/base/i.test(chainKey)) network = 'base';
  else if (/bnb-smart-chain/i.test(chainKey)) network = 'bnb-smart-chain';
  else return null;
  return { token, network };
}

// Function to generate wallets (placeholder)
async function generateWallet(chain) {
  // Implement actual wallet generation logic here
  // For now, return a dummy wallet address
  return '0x' + crypto.randomBytes(20).toString('hex');
}

// Function to verify bank account using Paystack API
async function verifyBankAccount(accountNumber, bankCode) {
  try {
    const response = await axios.get(`https://api.paystack.co/bank/resolve`, {
      params: { account_number: accountNumber, bank_code: bankCode },
      headers: { Authorization: `Bearer ${PAYSTACK_API_KEY}` },
    });
    return response.data;
  } catch (error) {
    logger.error(`Error verifying bank account (${accountNumber}, ${bankCode}): ${error.response ? error.response.data.message : error.message}`);
    throw new Error('Failed to verify bank account. Please try again later.');
  }
}

// Function to map chain and asset to Blockradar parameters (placeholder)
function mapToBlockradar(chain, asset) {
  // Implement actual mapping logic here
  return {
    chain: chain,
    assetId: 'mapped_asset_id', // Replace with actual mapping
  };
}

// =================== Scenes Definition ===================
const stage = new Scenes.Stage([
  // Define all scenes here
  // Ensure each scene is defined only once
  bankLinkingScene,
  supportScene,
  sendMessageScene,
  searchTransactionScene,
  broadcastMessageScene, // Ensure this scene is defined
  // Add other scenes as needed
]);

// =================== Bank Linking Scene ===================
const bankLinkingScene = new Scenes.BaseScene('bank_linking_scene');

bankLinkingScene.enter(async (ctx) => {
  const userId = ctx.from.id.toString();
  const walletIndex = ctx.session.walletIndex;

  if (walletIndex === undefined || walletIndex === null) {
    await ctx.replyWithMarkdown('⚠️ No wallet selected for linking. Please generate a wallet first.');
    ctx.scene.leave();
    return;
  }

  ctx.session.isBankLinking = true;
  ctx.session.bankData = {};
  ctx.session.bankData.step = 1;
  ctx.replyWithMarkdown('🏦 Please enter your bank name (e.g., Access Bank):');

  // Start the inactivity timeout
  ctx.session.bankLinkingTimeout = setTimeout(() => {
    if (ctx.session.isBankLinking) {
      ctx.replyWithMarkdown('⏰ Bank linking process timed out due to inactivity. Please start again if you wish to link a bank account.');
      ctx.scene.leave();
    }
  }, 300000); // 5 minutes timeout
});

// Handle Text Inputs in Bank Linking Scene
bankLinkingScene.on('text', async (ctx) => {
  const userId = ctx.from.id.toString();
  const input = ctx.message.text.trim();

  // Clear the inactivity timeout upon receiving input
  if (ctx.session.bankLinkingTimeout) {
    clearTimeout(ctx.session.bankLinkingTimeout);
  }

  if (ctx.session.bankData.step === 1) {
    // Step 1: Process Bank Name
    const bankNameInput = input.toLowerCase();
    const bank = bankList.find((b) => b.aliases.includes(bankNameInput));

    if (!bank) {
      return await ctx.replyWithMarkdown('❌ Invalid bank name. Please enter a valid bank name from our supported list:\n\n' + bankList.map(b => `• ${b.name}`).join('\n'));
    }

    ctx.session.bankData.bankName = bank.name;
    ctx.session.bankData.bankCode = bank.code;
    ctx.session.bankData.step = 2;

    await ctx.replyWithMarkdown('🔢 Please enter your 10-digit bank account number:');

    // Restart the inactivity timeout
    ctx.session.bankLinkingTimeout = setTimeout(() => {
      if (ctx.session.isBankLinking) {
        ctx.replyWithMarkdown('⏰ Bank linking process timed out due to inactivity. Please start again if you wish to link a bank account.');
        ctx.scene.leave();
      }
    }, 300000); // 5 minutes timeout
  } else if (ctx.session.bankData.step === 2) {
    // Step 2: Process Account Number
    if (!/^\d{10}$/.test(input)) {
      return await ctx.replyWithMarkdown('❌ Invalid account number. Please enter a valid 10-digit account number:');
    }

    ctx.session.bankData.accountNumber = input;
    ctx.session.bankData.step = 3;

    // Verify Bank Account
    await ctx.replyWithMarkdown('🔄 Verifying your bank details...');

    try {
      const verificationResult = await verifyBankAccount(ctx.session.bankData.accountNumber, ctx.session.bankData.bankCode);

      if (!verificationResult || !verificationResult.data) {
        throw new Error('Invalid verification response.');
      }

      const accountName = verificationResult.data.account_name;

      if (!accountName) {
        throw new Error('Unable to retrieve account name.');
      }

      ctx.session.bankData.accountName = accountName;
      ctx.session.bankData.step = 4;

      // Ask for Confirmation
      await ctx.replyWithMarkdown(
        `🏦 *Bank Account Verification*\n\n` +
        `Please confirm your bank details:\n` +
        `- *Bank Name:* ${ctx.session.bankData.bankName}\n` +
        `- *Account Number:* ${ctx.session.bankData.accountNumber}\n` +
        `- *Account Holder:* ${accountName}\n\n` +
        `Is this information correct?`,
        Markup.inlineKeyboard([
          [Markup.button.callback('✅ Yes, Confirm', 'confirm_bank_yes')],
          [Markup.button.callback('❌ No, Edit Details', 'confirm_bank_no')],
          [Markup.button.callback('❌ Cancel Linking', 'cancel_bank_linking')], // New cancellation option
        ])
      );

      // Restart the inactivity timeout
      ctx.session.bankLinkingTimeout = setTimeout(() => {
        if (ctx.session.isBankLinking) {
          ctx.replyWithMarkdown('⏰ Bank linking process timed out due to inactivity. Please start again if you wish to link a bank account.');
          ctx.scene.leave();
        }
      }, 300000); // 5 minutes timeout
    } catch (error) {
      logger.error(`Error verifying bank account for user ${userId}: ${error.message}`);
      await ctx.replyWithMarkdown('❌ Failed to verify your bank account. Please ensure your details are correct or try again later.');
      ctx.scene.leave();
    }
  }
});

// Confirm Bank Account
bankLinkingScene.action('confirm_bank_yes', async (ctx) => {
  const userId = ctx.from.id.toString();
  const bankData = ctx.session.bankData;
  const walletIndex = ctx.session.walletIndex;

  try {
    let userState = await getUserState(userId);

    if (walletIndex === undefined || walletIndex === null || !userState.wallets[walletIndex]) {
      await ctx.replyWithMarkdown('⚠️ No wallet selected for linking. Please generate a wallet first.');
      ctx.scene.leave();
      return;
    }

    // Update Bank Details for the Selected Wallet
    userState.wallets[walletIndex].bank = {
      bankName: bankData.bankName,
      bankCode: bankData.bankCode,
      accountNumber: bankData.accountNumber,
      accountName: bankData.accountName,
    };

    // Update User State in Firestore
    await updateUserState(userId, {
      wallets: userState.wallets,
    });

    // Prepare Confirmation Message with Wallet Details
    let confirmationMessage = `✅ *Bank Account Linked Successfully!*\n\n`;
    confirmationMessage += `*Bank Name:* ${bankData.bankName}\n`;
    confirmationMessage += `*Account Number:* ${bankData.accountNumber}\n`;
    confirmationMessage += `*Account Holder:* ${bankData.accountName}\n\n`;
    confirmationMessage += `📂 *Linked Wallet Details:*\n`;
    confirmationMessage += `• *Chain:* ${userState.wallets[walletIndex].chain}\n`;
    confirmationMessage += `• *Address:* \`${userState.wallets[walletIndex].address}\`\n\n`;
    confirmationMessage += `You can now receive payouts to this bank account.`;

    await ctx.replyWithMarkdown(confirmationMessage, getMainMenu(true, userState.wallets.some(w => w.bank)));

    // Log to Admin
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `🔗 User ${userId} linked a bank account:\n\n` +
      `*Account Name:* ${userState.wallets[walletIndex].bank.accountName}\n` +
      `*Bank Name:* ${userState.wallets[walletIndex].bank.bankName}\n` +
      `*Account Number:* ****${userState.wallets[walletIndex].bank.accountNumber.slice(-4)}`, { parse_mode: 'Markdown' });
    logger.info(`User ${userId} linked a bank account: ${JSON.stringify(userState.wallets[walletIndex].bank)}`);

    // Clear the inactivity timeout
    if (ctx.session.bankLinkingTimeout) {
      clearTimeout(ctx.session.bankLinkingTimeout);
      delete ctx.session.bankLinkingTimeout;
    }

    // Clean up session variables related to bank linking
    delete ctx.session.walletIndex;
    delete ctx.session.bankData;
    delete ctx.session.isBankLinking;

    // Exit the bank linking scene
    ctx.scene.leave();

    // Acknowledge the Callback to Remove Loading State
    await ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error in confirm_bank_yes handler for user ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('❌ An error occurred while confirming your bank details. Please try again later.');
    ctx.scene.leave();
  }
});

// Decline Bank Account Confirmation
bankLinkingScene.action('confirm_bank_no', async (ctx) => {
  await ctx.replyWithMarkdown('⚠️ Let\'s try again.');

  // Reset Bank Data and Restart the Scene
  ctx.session.bankData = {};
  ctx.session.bankData.step = 1;

  // Restart the inactivity timeout
  if (ctx.session.bankLinkingTimeout) {
    clearTimeout(ctx.session.bankLinkingTimeout);
  }
  ctx.session.bankLinkingTimeout = setTimeout(() => {
    if (ctx.session.isBankLinking) {
      ctx.replyWithMarkdown('⏰ Bank linking process timed out due to inactivity. Please start again if you wish to link a bank account.');
      ctx.scene.leave();
    }
  }, 300000); // 5 minutes timeout

  ctx.scene.reenter(); // Restart the scene

  await ctx.answerCbQuery();
});

// Handle Cancellation of Bank Linking
bankLinkingScene.action('cancel_bank_linking', async (ctx) => {
  await ctx.replyWithMarkdown('❌ Bank linking process has been canceled.');

  // Clean Up Session Variables
  delete ctx.session.walletIndex;
  delete ctx.session.bankData;
  delete ctx.session.processType;
  delete ctx.session.isBankLinking; // Ensure flag is reset

  // Clear the inactivity timeout
  if (ctx.session.bankLinkingTimeout) {
    clearTimeout(ctx.session.bankLinkingTimeout);
    delete ctx.session.bankLinkingTimeout;
  }

  ctx.scene.leave();
});

// Register the bank linking scene
stage.register(bankLinkingScene);

// =================== Support Scene ===================
const supportScene = new Scenes.BaseScene('support_scene');

supportScene.enter(async (ctx) => {
  await ctx.replyWithMarkdown('💬 *Support*\n\nPlease enter the message you want to send to our support team:', Markup.inlineKeyboard([
    [Markup.button.callback('❌ Cancel', 'support_cancel')]
  ]));
});

supportScene.on('message', async (ctx) => {
  const userId = ctx.from.id.toString();
  const message = ctx.message.text || '📷 Photo Received'; // Handle photos if needed

  try {
    // Forward the message to admin
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `📩 *Support Message from User ${userId}:*\n\n${message}`, { parse_mode: 'Markdown' });

    // Inform the user
    await ctx.replyWithMarkdown('✅ Your message has been sent to our support team and is under review.');

    // Log the support request
    logger.info(`User ${userId} sent a support message: ${message}`);

    // Optionally, store the support request in Firestore
    await db.collection('support_requests').add({
      userId: userId,
      message: message,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Exit the scene
    ctx.scene.leave();
  } catch (error) {
    logger.error(`Error forwarding support message from user ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ Failed to send your message. Please try again later.');
    ctx.scene.leave();
  }
});

supportScene.action('support_cancel', async (ctx) => {
  await ctx.replyWithMarkdown('❌ Support request has been canceled.');
  ctx.scene.leave();
});

// Register the support scene
stage.register(supportScene);

// =================== Send Message Scene ===================
const sendMessageScene = new Scenes.BaseScene('send_message_scene');

sendMessageScene.enter(async (ctx) => {
  await ctx.replyWithMarkdown('📩 *Send Message to User*\n\nPlease enter the User ID you want to message:', Markup.inlineKeyboard([
    [Markup.button.callback('❌ Cancel', 'send_message_cancel')]
  ]));
});

sendMessageScene.on('message', async (ctx) => {
  const adminId = ctx.from.id.toString();
  const userIdToMessage = ctx.message.text.trim();

  // Validate User ID
  if (!/^\d{5,15}$/.test(userIdToMessage)) {
    return ctx.replyWithMarkdown('❌ Invalid User ID. Please enter a valid numeric User ID (5-15 digits):');
  }

  // Check if the user exists
  const userDoc = await db.collection('users').doc(userIdToMessage).get();
  if (!userDoc.exists) {
    return ctx.replyWithMarkdown('❌ User ID not found. Please ensure the User ID is correct or try another one:');
  }

  // Proceed to capture the message
  ctx.session.adminSendingMessageTo = userIdToMessage;
  await ctx.replyWithMarkdown('📝 Please enter the message you want to send to the user. You can also attach an image (receipt) with your message:', Markup.inlineKeyboard([
    [Markup.button.callback('❌ Cancel', 'send_message_cancel')]
  ]));
});

// Handle sending the message
sendMessageScene.on('message', async (ctx) => {
  const adminId = ctx.from.id.toString();
  const userIdToMessage = ctx.session.adminSendingMessageTo;
  const messageContent = ctx.message.text || '📷 Photo Received';

  try {
    if (ctx.message.photo) {
      // Handle photo message
      const photoArray = ctx.message.photo;
      const highestResolutionPhoto = photoArray[photoArray.length - 1];
      const fileId = highestResolutionPhoto.file_id;
      const caption = ctx.message.caption || '';

      await bot.telegram.sendPhoto(userIdToMessage, fileId, { caption: caption, parse_mode: 'Markdown' });
      await ctx.replyWithMarkdown('✅ Photo message sent successfully.');
      logger.info(`Admin ${adminId} sent a photo message to user ${userIdToMessage}. Caption: ${caption}`);
    } else if (ctx.message.text) {
      // Handle text message
      const messageText = ctx.message.text.trim();
      if (!messageText) {
        return ctx.reply('❌ Message content cannot be empty. Please enter a valid message:');
      }

      await bot.telegram.sendMessage(userIdToMessage, `📩 *Message from Admin:* \n\n${messageText}`, { parse_mode: 'Markdown' });
      await ctx.replyWithMarkdown('✅ Text message sent successfully.');
      logger.info(`Admin ${adminId} sent a text message to user ${userIdToMessage}: ${messageText}`);
    } else {
      await ctx.reply('❌ Unsupported message type. Please send text or a photo (receipt).');
      return;
    }

    // Inform the admin
    await ctx.replyWithMarkdown('✅ Your message has been sent successfully.');

    // Reset session variables
    delete ctx.session.adminSendingMessageTo;

    // Exit the scene
    ctx.scene.leave();
  } catch (error) {
    logger.error(`Error sending message to user ${userIdToMessage}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ Error sending message. Please ensure the User ID is correct and the user has not blocked the bot.');
    ctx.scene.leave();
  }
});

sendMessageScene.action('send_message_cancel', async (ctx) => {
  await ctx.replyWithMarkdown('❌ Message sending process has been canceled.');
  delete ctx.session.adminSendingMessageTo;
  ctx.scene.leave();
});

// Register the send message scene
stage.register(sendMessageScene);

// =================== Search Transaction Scene ===================
const searchTransactionScene = new Scenes.BaseScene('search_transaction_scene');

searchTransactionScene.enter(async (ctx) => {
  await ctx.replyWithMarkdown('🔍 *Search Transaction*\n\nPlease enter the *Reference ID* of the transaction you want to search for:', Markup.inlineKeyboard([
    [Markup.button.callback('❌ Cancel', 'search_transaction_cancel')]
  ]));
});

searchTransactionScene.on('text', async (ctx) => {
  const adminId = ctx.from.id.toString();
  const referenceId = ctx.message.text.trim();
  
  if (!referenceId) {
    return ctx.replyWithMarkdown('❌ Reference ID cannot be empty. Please enter a valid Reference ID:');
  }

  try {
    // Query Firestore for the transaction
    const transactionSnapshot = await db.collection('transactions').where('referenceId', '==', referenceId).limit(1).get();
    
    if (transactionSnapshot.empty) {
      return ctx.replyWithMarkdown(`❌ No transaction found with Reference ID: \`${referenceId}\`.`);
    }
    
    const transactionDoc = transactionSnapshot.docs[0];
    const transactionData = transactionDoc.data();
    
    // Display transaction details with inline buttons for status updates
    let message = `🔍 *Transaction Details*\n\n`;
    message += `• *Reference ID:* \`${transactionData.referenceId || 'N/A'}\`\n`;
    message += `• *User ID:* ${transactionData.userId || 'N/A'}\n`;
    message += `• *Amount:* ${transactionData.amount || 'N/A'} ${transactionData.asset || 'N/A'}\n`;
    message += `• *Status:* ${transactionData.status || 'Pending'}\n`;
    message += `• *Transaction Hash:* \`${transactionData.transactionHash || 'N/A'}\`\n`;
    message += `• *Date:* ${transactionData.timestamp ? new Date(transactionData.timestamp.toDate()).toLocaleString() : 'N/A'}\n`;
    message += `• *Chain:* ${transactionData.chain || 'N/A'}\n`;
    // Add more fields as necessary
    
    // Inline buttons for updating status
    const statusButtons = [];
    if (transactionData.status !== 'Pending') {
      statusButtons.push(Markup.button.callback('🔄 Set to Pending', `update_status_${transactionData.referenceId}_Pending`));
    }
    if (transactionData.status !== 'Completed') {
      statusButtons.push(Markup.button.callback('✅ Set to Completed', `update_status_${transactionData.referenceId}_Completed`));
    }
    if (transactionData.status !== 'Failed') {
      statusButtons.push(Markup.button.callback('❌ Set to Failed', `update_status_${transactionData.referenceId}_Failed`));
    }
    
    statusButtons.push(Markup.button.callback('🔙 Back', 'search_transaction_back'));
    
    await ctx.replyWithMarkdown(message, Markup.inlineKeyboard([
      statusButtons
    ]));
    
    // Optionally, log the search action
    logger.info(`Admin ${adminId} searched for transaction with Reference ID: ${referenceId}`);
    
  } catch (error) {
    logger.error(`Error searching for transaction with Reference ID ${referenceId}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred while searching for the transaction. Please try again later.');
  }
});

searchTransactionScene.action('search_transaction_cancel', async (ctx) => {
  await ctx.replyWithMarkdown('❌ Transaction search has been canceled.');
  ctx.scene.leave();
});

searchTransactionScene.action('search_transaction_back', async (ctx) => {
  await ctx.replyWithMarkdown('🔍 *Search Transaction*\n\nPlease enter the *Reference ID* of the transaction you want to search for:');
  await ctx.answerCbQuery();
});

// Register the search transaction scene
stage.register(searchTransactionScene);

// =================== Handle Status Update Actions ===================
bot.action(/update_status_(.+)_(.+)/, async (ctx) => {
  const adminId = ctx.from.id.toString();
  const referenceId = ctx.match[1];
  const newStatus = ctx.match[2];
  
  try {
    // Fetch the transaction
    const transactionSnapshot = await db.collection('transactions').where('referenceId', '==', referenceId).limit(1).get();
    
    if (transactionSnapshot.empty) {
      await ctx.replyWithMarkdown(`❌ No transaction found with Reference ID: \`${referenceId}\`.`);
      return ctx.answerCbQuery();
    }
    
    const transactionDoc = transactionSnapshot.docs[0];
    const transactionData = transactionDoc.data();
    
    // Update the status
    await db.collection('transactions').doc(transactionDoc.id).update({
      status: newStatus,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    
    // Notify the admin of the successful update
    await ctx.replyWithMarkdown(`✅ Transaction \`${referenceId}\` has been updated to *${newStatus}*.`);
    
    // Notify the user about the status update
    await bot.telegram.sendMessage(transactionData.userId, `🔄 *Transaction Update*\n\nYour transaction with Reference ID \`${referenceId}\` has been updated to *${newStatus}*.`);
    
    // Log the status update
    logger.info(`Admin ${adminId} updated transaction ${referenceId} to ${newStatus}`);
    
    // Acknowledge the callback to remove the loading state
    await ctx.answerCbQuery();
    
    // Optionally, edit the original transaction details message to reflect the new status
    // This requires tracking the message ID where the transaction details were sent
    // If you have stored the message ID in Firestore or elsewhere, you can implement this
  } catch (error) {
    logger.error(`Error updating status for transaction ${referenceId}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred while updating the transaction status. Please try again later.');
    await ctx.answerCbQuery();
  }
});

// =================== Admin Panel Actions ===================

// Entry point for Admin Panel
bot.action('open_admin_panel', async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isAdmin(userId)) {
    return ctx.reply('⚠️ Unauthorized access.');
  }

  // Reset session variables if necessary
  ctx.session.adminMessageId = null;

  const sentMessage = await ctx.reply('👨‍💼 **Admin Panel**\n\nSelect an option below:', getAdminMenu());
  ctx.session.adminMessageId = sentMessage.message_id;

  // Set a timeout to delete the admin panel message after 5 minutes
  setTimeout(() => {
    if (ctx.session.adminMessageId) {
      ctx.deleteMessage(ctx.session.adminMessageId).catch(() => {});
      ctx.session.adminMessageId = null;
    }
  }, 300000); // Delete after 5 minutes
});

// Handle Admin Menu Actions
bot.action(/admin_(.+)/, async (ctx) => {
  const userId = ctx.from.id.toString();

  if (!isAdmin(userId)) {
    return ctx.reply('⚠️ Unauthorized access.');
  }

  const action = ctx.match[1];

  switch (action) {
    case 'admin_view_transactions':
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
          message += `• *Reference ID:* \`${tx.referenceId || 'N/A'}\`\n`;
          message += `*User ID:* ${tx.userId || 'N/A'}\n`;
          message += `*Amount:* ${tx.amount || 'N/A'} ${tx.asset || 'N/A'}\n`;
          message += `*Status:* ${tx.status || 'Pending'}\n`;
          message += `*Date:* ${tx.timestamp ? new Date(tx.timestamp.toDate()).toLocaleString() : 'N/A'}\n`;
          message += `*Chain:* ${tx.chain || 'N/A'}\n\n`;
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

    case 'admin_user_statistics':
      // Handle viewing user statistics
      try {
        const usersSnapshot = await db.collection('users').get();
        const transactionsSnapshot = await db.collection('transactions').where('status', '==', 'Completed').get();

        const totalUsers = usersSnapshot.size;
        const activeUsers = usersSnapshot.docs.filter(doc => doc.data().isActive).length;
        const successfulTransactions = transactionsSnapshot.size;

        let message = `👥 **User Statistics**:\n\n`;
        message += `• *Total Users:* ${totalUsers}\n`;
        message += `• *Active Users:* ${activeUsers}\n`;
        message += `• *Successful Transactions:* ${successfulTransactions}\n\n`;
        message += `📋 *User Details*:\n`;

        usersSnapshot.forEach(doc => {
          const user = doc.data();
          const username = user.username || 'N/A';
          const dateJoined = user.dateJoined ? user.dateJoined.toDate().toLocaleString() : 'N/A';
          const userTxCount = user.transactionCount || 0; // Assuming you track this
          message += `• *Username:* ${username}\n`;
          message += `  • *User ID:* ${doc.id}\n`;
          message += `  • *Date Joined:* ${dateJoined}\n`;
          message += `  • *Successful Transactions:* ${userTxCount}\n\n`;
        });

        // Add a 'Back' button to return to the admin menu
        const inlineKeyboard = Markup.inlineKeyboard([
          [Markup.button.callback('🔙 Back to Admin Menu', 'admin_back_to_main')]
        ]);

        // Edit the admin panel message
        await ctx.editMessageText(message, { parse_mode: 'Markdown', reply_markup: inlineKeyboard.reply_markup });
        ctx.answerCbQuery();
      } catch (error) {
        logger.error(`Error fetching user statistics: ${error.message}`);
        await ctx.answerCbQuery('⚠️ Unable to fetch user statistics.', { show_alert: true });
      }
      break;

    case 'admin_search_transaction':
      // Handle searching for a transaction
      await ctx.scene.enter('search_transaction_scene');
      ctx.answerCbQuery();
      break;

    case 'admin_send_message':
      // Handle sending messages
      await ctx.scene.enter('send_message_scene');
      ctx.answerCbQuery();
      break;

    case 'admin_mark_paid':
      // Handle marking transactions as paid
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
              `*Reference ID:* \`${txData.referenceId || 'N/A'}\`\n` +
              `*Amount Paid:* ${txData.amount} ${txData.asset}\n` +
              `*Bank:* ${txData.bankDetails.bankName || 'N/A'}\n` +
              `*Account Name:* ${accountName}\n` +
              `*Account Number:* ****${txData.bankDetails.accountNumber.slice(-4)}\n` +
              `*Payout (NGN):* ₦${payout}\n\n` +
              `🔹 *Chain:* ${txData.chain}\n` +
              `*Date:* ${new Date(txData.timestamp.toDate()).toLocaleString()}\n\n` +
              `Thank you for using *DirectPay*! Your funds have been securely transferred to your bank account. If you have any questions or need further assistance, feel free to [contact our support team](https://t.me/maxcswap).`,
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

    case 'admin_view_users':
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
          message += `• *User ID:* ${doc.id}\n`;
          message += `  • *Username:* ${user.username || 'N/A'}\n`;
          message += `  • *Number of Wallets:* ${user.wallets.length}\n`;
          message += `  • *Bank Linked:* ${user.wallets.some(wallet => wallet.bank) ? '✅ Yes' : '❌ No'}\n`;
          message += `  • *Date Joined:* ${user.dateJoined ? user.dateJoined.toDate().toLocaleString() : 'N/A'}\n\n`;
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

    case 'admin_broadcast_message':
      // Handle broadcasting messages (assuming you have a broadcast_message_scene implemented)
      await ctx.scene.enter('broadcast_message_scene'); // Implement this scene as needed
      ctx.answerCbQuery();
      break;

    case 'admin_manage_banks':
      // Implement bank management functionalities here
      await ctx.replyWithMarkdown('🏦 **Bank Management**\n\nComing Soon!', { parse_mode: 'Markdown', reply_markup: getAdminMenu().reply_markup });
      ctx.answerCbQuery();
      break;

    case 'admin_back_to_main':
      // Return to the main menu
      await greetUser(ctx); // Implement greetUser to send the admin menu to the admin
      // Delete the admin panel message
      if (ctx.session.adminMessageId) {
        await ctx.deleteMessage(ctx.session.adminMessageId).catch(() => {});
        ctx.session.adminMessageId = null;
      }
      ctx.answerCbQuery();
      break;

    default:
      await ctx.answerCbQuery('⚠️ Unknown action. Please select an option from the menu.', { show_alert: true });
  }
});

// =================== Broadcast Message Scene ===================
const broadcastMessageScene = new Scenes.BaseScene('broadcast_message_scene');

broadcastMessageScene.enter(async (ctx) => {
  await ctx.replyWithMarkdown('📢 *Broadcast Message*\n\nPlease enter the message you want to broadcast to all users. You can also attach a photo (receipt) with your message:', Markup.inlineKeyboard([
    [Markup.button.callback('❌ Cancel', 'broadcast_cancel')]
  ]));
});

broadcastMessageScene.on('message', async (ctx) => {
  const adminId = ctx.from.id.toString();
  const broadcastMessage = ctx.message.text || '📷 Photo Received';

  try {
    const usersSnapshot = await db.collection('users').get();
    if (usersSnapshot.empty) {
      await ctx.reply('No users to broadcast to.', getAdminMenu());
      ctx.scene.leave();
      return;
    }

    let successCount = 0;
    let failureCount = 0;

    // Initialize rate limiter to prevent hitting Telegram's rate limits
    const limiter = new Bottleneck({
      minTime: 200, // 200ms between requests
      maxConcurrent: 5, // Maximum 5 concurrent requests
    });

    if (ctx.message.photo) {
      // Handle photo broadcast
      const photoArray = ctx.message.photo;
      const highestResolutionPhoto = photoArray[photoArray.length - 1]; // Get the highest resolution photo
      const fileId = highestResolutionPhoto.file_id;
      const caption = ctx.message.caption || '';

      // Wrap the sendPhoto function with the limiter
      const limitedSendPhoto = limiter.wrap(bot.telegram.sendPhoto.bind(bot.telegram));

      for (const doc of usersSnapshot.docs) {
        const targetUserId = doc.id;
        try {
          await limitedSendPhoto(targetUserId, fileId, { caption: caption, parse_mode: 'Markdown' });
          successCount++;
        } catch (error) {
          logger.error(`Error sending broadcast photo to user ${targetUserId}: ${error.message}`);
          failureCount++;
        }
      }

      await ctx.reply(`✅ Broadcast completed.\n\n📬 Successful: ${successCount}\n❌ Failed: ${failureCount}`, getAdminMenu());
      logger.info(`Admin ${adminId} broadcasted photo message. Success: ${successCount}, Failed: ${failureCount}`);
    } else if (ctx.message.text) {
      // Handle text broadcast
      const messageText = broadcastMessage.trim();
      if (!messageText) {
        return ctx.reply('❌ Message content cannot be empty. Please enter a valid message:');
      }

      // Wrap the sendMessage function with the limiter
      const limitedSendMessage = limiter.wrap(bot.telegram.sendMessage.bind(bot.telegram));

      for (const doc of usersSnapshot.docs) {
        const targetUserId = doc.id;
        try {
          await limitedSendMessage(targetUserId, `📢 *Broadcast Message:*\n\n${messageText}`, { parse_mode: 'Markdown' });
          successCount++;
        } catch (error) {
          logger.error(`Error sending broadcast message to user ${targetUserId}: ${error.message}`);
          failureCount++;
        }
      }

      await ctx.reply(`✅ Broadcast completed.\n\n📬 Successful: ${successCount}\n❌ Failed: ${failureCount}`, getAdminMenu());
      logger.info(`Admin ${adminId} broadcasted text message. Success: ${successCount}, Failed: ${failureCount}`);
    } else {
      // Unsupported message type
      await ctx.reply('❌ Unsupported message type. Please send text or a photo (receipt).', getAdminMenu());
    }

    ctx.scene.leave();
  } catch (error) {
    logger.error(`Error in broadcast_message_scene: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred while broadcasting the message. Please try again later.', getAdminMenu());
    ctx.scene.leave();
  }
});

broadcastMessageScene.action('broadcast_cancel', async (ctx) => {
  await ctx.replyWithMarkdown('❌ Broadcast process has been canceled.');
  ctx.scene.leave();
});

// Register the broadcast message scene
stage.register(broadcastMessageScene);

// =================== Initialize Scene Middleware ===================
bot.use(session());
bot.use(stage.middleware());

// =================== Greet User Function ===================
// Note: Ensure this function is defined only once.
async function greetUser(ctx) {
  const userId = ctx.from.id.toString();
  let userState;
  try {
    userState = await getUserState(userId);
  } catch (error) {
    logger.error(`Error fetching user state for ${userId}: ${error.message}`);
    await ctx.reply('⚠️ An error occurred. Please try again later.');
    return;
  }

  // If user is new, send a welcome message
  if (!userState.dateJoined) {
    await ctx.reply('👋 Welcome to DirectPay! I am here to help you manage your crypto transactions securely.');
    // Update dateJoined
    await updateUserState(userId, { dateJoined: admin.firestore.FieldValue.serverTimestamp() });
  }

  // Provide the main menu
  await ctx.reply('📋 Here is your main menu:', getMainMenu(userState.wallets.length > 0, userState.wallets.some(wallet => wallet.bank)));
}

// =================== Handle User Commands and Messages ===================

// Start Command
bot.start(async (ctx) => {
  await greetUser(ctx);
});

// Help Command
bot.help(async (ctx) => {
  await ctx.reply('📖 *Help*\n\nHere are the commands you can use:\n\n• *Generate Wallet* - Create a new crypto wallet.\n• *View Wallet* - View your existing wallets.\n• *Settings* - Manage your settings.\n• *Transactions* - View your transactions.\n• *Support* - Contact support.\n• *View Current Rates* - Check current exchange rates.', { parse_mode: 'Markdown' });
});

// Handle Text Messages
bot.on('text', async (ctx) => {
  const userId = ctx.from.id.toString();
  const text = ctx.message.text.trim();

  // Handle different user commands based on text
  switch (text) {
    case '💼 Generate Wallet':
      // Implement wallet generation logic
      try {
        let userState = await getUserState(userId);
        if (userState.wallets.length >= MAX_WALLETS) {
          return ctx.reply(`❌ You have reached the maximum number of wallets (${MAX_WALLETS}). Please delete an existing wallet before creating a new one.`);
        }

        // For simplicity, ask the user to select a chain
        await ctx.replyWithMarkdown('🔗 *Select the blockchain network for your new wallet:*', Markup.inlineKeyboard([
          [Markup.button.callback('🟣 Polygon', 'generate_wallet_polygon')],
          [Markup.button.callback('🔵 Base', 'generate_wallet_base')],
          [Markup.button.callback('🟢 BNB Smart Chain', 'generate_wallet_bnb')],
          [Markup.button.callback('❌ Cancel', 'generate_wallet_cancel')]
        ]));
      } catch (error) {
        logger.error(`Error generating wallet for user ${userId}: ${error.message}`);
        await ctx.reply('⚠️ An error occurred while generating your wallet. Please try again later.');
      }
      break;

    case '💼 View Wallet':
      // Implement wallet viewing logic
      try {
        let userState = await getUserState(userId);
        if (userState.wallets.length === 0) {
          return ctx.reply('❌ You have no wallets. Please generate a wallet first.');
        }

        let message = '💼 **Your Wallets:**\n\n';
        userState.wallets.forEach((wallet, index) => {
          message += `• *Wallet ${index + 1}:*\n`;
          message += `  • *Chain:* ${wallet.chain}\n`;
          message += `  • *Address:* \`${wallet.address}\`\n`;
          message += `  • *Bank Linked:* ${wallet.bank ? '✅ Yes' : '❌ No'}\n\n`;
        });

        await ctx.replyWithMarkdown(message, getMainMenu(true, userState.wallets.some(wallet => wallet.bank)));
      } catch (error) {
        logger.error(`Error viewing wallets for user ${userId}: ${error.message}`);
        await ctx.reply('⚠️ An error occurred while retrieving your wallets. Please try again later.');
      }
      break;

    case '⚙️ Settings':
      // Implement settings menu
      try {
        await ctx.replyWithMarkdown('⚙️ *Settings*\n\nPlease choose an option below:', getSettingsMenu());
      } catch (error) {
        logger.error(`Error accessing settings for user ${userId}: ${error.message}`);
        await ctx.reply('⚠️ An error occurred while accessing settings. Please try again later.');
      }
      break;

    case '💰 Transactions':
      // Implement transaction viewing logic
      try {
        let userState = await getUserState(userId);
        const transactionsSnapshot = await db.collection('transactions').where('userId', '==', userId).orderBy('timestamp', 'desc').limit(10).get();

        if (transactionsSnapshot.empty) {
          return ctx.reply('❌ You have no transactions.');
        }

        let message = '💰 **Your Transactions**:\n\n';
        transactionsSnapshot.forEach((doc) => {
          const tx = doc.data();
          message += `• *Reference ID:* \`${tx.referenceId || 'N/A'}\`\n`;
          message += `  • *Amount:* ${tx.amount || 'N/A'} ${tx.asset || 'N/A'}\n`;
          message += `  • *Status:* ${tx.status || 'Pending'}\n`;
          message += `  • *Date:* ${tx.timestamp ? new Date(tx.timestamp.toDate()).toLocaleString() : 'N/A'}\n\n`;
        });

        await ctx.replyWithMarkdown(message, getMainMenu(true, userState.wallets.some(wallet => wallet.bank)));
      } catch (error) {
        logger.error(`Error viewing transactions for user ${userId}: ${error.message}`);
        await ctx.reply('⚠️ An error occurred while retrieving your transactions. Please try again later.');
      }
      break;

    case 'ℹ️ Support':
      // Enter support scene
      try {
        await ctx.scene.enter('support_scene');
      } catch (error) {
        logger.error(`Error entering support scene for user ${userId}: ${error.message}`);
        await ctx.reply('⚠️ An error occurred. Please try again later.');
      }
      break;

    case '📈 View Current Rates':
      // Implement viewing current exchange rates
      try {
        // Ensure exchangeRates are up-to-date
        await fetchExchangeRates();

        let message = '📈 *Current Exchange Rates (USD):*\n\n';
        for (const [asset, rate] of Object.entries(exchangeRates)) {
          message += `• *${asset}:* 1 ${asset} = ${rate} USD\n`;
        }

        await ctx.replyWithMarkdown(message);
      } catch (error) {
        logger.error(`Error fetching exchange rates for user ${userId}: ${error.message}`);
        await ctx.reply('⚠️ An error occurred while fetching exchange rates. Please try again later.');
      }
      break;

    default:
      await ctx.reply('⚠️ I did not understand that command. Please select an option from the menu.');
  }
});

// =================== Handle Settings Actions ===================
bot.action(/settings_(.+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const action = ctx.match[1];

  switch (action) {
    case 'edit_bank':
      // Start bank linking scene
      try {
        // Fetch user wallets to dynamically create buttons
        let userState = await getUserState(userId);
        if (userState.wallets.length === 0) {
          return ctx.reply('❌ You have no wallets to link a bank account. Please generate a wallet first.');
        }

        const walletButtons = userState.wallets.map((wallet, index) => [
          Markup.button.callback(`Wallet ${index + 1}`, `select_wallet_${index}`)
        ]);

        walletButtons.push([Markup.button.callback('❌ Cancel', 'settings_cancel')]);

        await ctx.reply('🔗 *Edit Linked Bank Details*\n\nPlease select the wallet you want to link a bank to:', Markup.inlineKeyboard(walletButtons));
      } catch (error) {
        logger.error(`Error accessing bank settings for user ${userId}: ${error.message}`);
        await ctx.reply('⚠️ An error occurred while accessing bank settings. Please try again later.');
      }
      break;

    case 'generate_wallet':
      // Implement wallet generation logic
      try {
        let userState = await getUserState(userId);
        if (userState.wallets.length >= MAX_WALLETS) {
          return ctx.reply(`❌ You have reached the maximum number of wallets (${MAX_WALLETS}). Please delete an existing wallet before creating a new one.`);
        }

        // For simplicity, ask the user to select a chain
        await ctx.replyWithMarkdown('🔗 *Select the blockchain network for your new wallet:*', Markup.inlineKeyboard([
          [Markup.button.callback('🟣 Polygon', 'generate_wallet_polygon')],
          [Markup.button.callback('🔵 Base', 'generate_wallet_base')],
          [Markup.button.callback('🟢 BNB Smart Chain', 'generate_wallet_bnb')],
          [Markup.button.callback('❌ Cancel', 'generate_wallet_cancel')]
        ]));
      } catch (error) {
        logger.error(`Error generating wallet for user ${userId}: ${error.message}`);
        await ctx.reply('⚠️ An error occurred while generating your wallet. Please try again later.');
      }
      break;

    case 'contact_support':
      // Enter support scene
      try {
        await ctx.scene.enter('support_scene');
      } catch (error) {
        logger.error(`Error entering support scene for user ${userId}: ${error.message}`);
        await ctx.reply('⚠️ An error occurred. Please try again later.');
      }
      break;

    case 'settings_cancel':
      // Cancel settings action
      await ctx.reply('❌ Settings operation has been canceled.');
      break;

    default:
      await ctx.reply('⚠️ Unknown settings action.');
  }
});

// =================== Transaction Search and Update Actions ===================

// (Already handled above)

// =================== Admin Actions for Messaging ===================

// (Already handled above)

// =================== Webhook Handlers ===================

// Function to Verify Paycrest Webhook Signature
function verifyPaycrestSignature(requestBody, signatureHeader, secretKey) {
  const calculatedSignature = calculateHmacSignature(requestBody, secretKey);
  return signatureHeader === calculatedSignature;
}

function calculateHmacSignature(data, secretKey) {
  const key = Buffer.from(secretKey);
  const hash = crypto.createHmac('sha256', key);
  hash.update(data);
  return hash.digest('hex');
}

// Paycrest Webhook Endpoint
app.post('/webhook/paycrest', async (req, res) => {
  const signature = req.headers['x-paycrest-signature'];
  const rawBody = JSON.stringify(req.body);

  if (!verifyPaycrestSignature(rawBody, signature, PAYCREST_CLIENT_SECRET)) {
    logger.error('Invalid Paycrest signature');
    return res.status(401).send('Invalid signature');
  }

  const event = req.body.event;
  const data = req.body.data;

  if (event === 'payment_order.settled') {
    const orderId = data.id;

    try {
      // Fetch transaction by paycrestOrderId
      const txSnapshot = await db.collection('transactions').where('paycrestOrderId', '==', orderId).limit(1).get();
      if (txSnapshot.empty) {
        logger.error(`No transaction found for Paycrest orderId: ${orderId}`);
        return res.status(200).send('OK');
      }

      const txDoc = txSnapshot.docs[0];
      const txData = txDoc.data();
      const userId = txData.userId;
      const messageId = txData.messageId;

      // Update transaction to Paid
      await db.collection('transactions').doc(txDoc.id).update({ status: 'Paid' });

      // Update user's transaction count and set as active
      try {
        const userDocRef = db.collection('users').doc(userId);
        const userDoc = await userDocRef.get();

        if (userDoc.exists) {
          const currentTxCount = userDoc.data().transactionCount || 0;
          await userDocRef.update({
            transactionCount: currentTxCount + 1,
            isActive: true, // Update based on your criteria
          });
        }
      } catch (error) {
        logger.error(`Error updating user transaction count for user ${userId}: ${error.message}`);
      }

      // Notify user
      await bot.telegram.sendMessage(userId, `🎉 *Funds Credited Successfully!*\n\n` +
        `Hello ${txData.firstName || 'Valued User'},\n\n` +
        `Your DirectPay order has been completed. Here are the details of your order:\n\n` +
        `*Crypto amount:* ${txData.amount} ${txData.asset}\n` +
        `*Cash amount:* NGN ${txData.payout}\n` +
        `*Network:* ${txData.chain}\n` +
        `*Date:* ${new Date(txData.timestamp).toISOString()}\n\n` +
        `To help us keep improving our services, please rate your experience with us.`,
        { parse_mode: 'Markdown' }
      );

      // Optionally, edit the pending message to indicate completion
      if (messageId) {
        try {
          await bot.telegram.editMessageText(userId, messageId, null, `🎉 *Funds Credited Successfully!*\n\n` +
            `Your DirectPay order has been completed. Here are the details of your order:\n\n` +
            `*Crypto amount:* ${txData.amount} ${txData.asset}\n` +
            `*Cash amount:* NGN ${txData.payout}\n` +
            `*Network:* ${txData.chain}\n` +
            `*Date:* ${new Date(txData.timestamp).toISOString()}\n\n` +
            `Thank you for using *DirectPay*! Your funds have been securely transferred to your bank account. If you have any questions or need further assistance, feel free to [contact our support team](https://t.me/maxcswap).`,
            { parse_mode: 'Markdown' }
          );
        } catch (error) {
          logger.error(`Error editing message for user ${userId}: ${error.message}`);
          // Optionally, notify admin about the failure to edit message
          await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ Failed to edit message for user ${userId}: ${error.message}`);
        }
      }

      // Notify admin about the successful payment
      await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `✅ *Payment Completed*\n\n` +
        `*User ID:* ${userId}\n` +
        `*Reference ID:* ${txData.referenceId}\n` +
        `*Amount:* ${txData.amount} ${txData.asset}\n` +
        `*Bank:* ${txData.bankDetails.bankName}\n` +
        `*Account Number:* ****${txData.bankDetails.accountNumber.slice(-4)}\n` +
        `*Date:* ${new Date(txData.timestamp.toDate()).toLocaleString()}\n`, { parse_mode: 'Markdown' });

      res.status(200).send('OK');
    } catch (error) {
      logger.error(`Error processing Paycrest webhook for orderId ${orderId}: ${error.message}`);
      res.status(500).send('Error');
      await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ Error processing Paycrest webhook for orderId ${orderId}: ${error.message}`);
    }
  } else {
    logger.info(`Unhandled Paycrest event: ${event}`);
    res.status(200).send('OK');
  }
});

// =================== Blockradar Webhook Handler with Idempotency ===================

app.post('/webhook/blockradar', async (req, res) => {
  try {
    const event = req.body;
    logger.info(`Received Blockradar webhook: ${JSON.stringify(event)}`);
    fs.appendFileSync(path.join(__dirname, 'webhook_logs.txt'), `${new Date().toISOString()} - ${JSON.stringify(event, null, 2)}\n`);

    // Extract common event data
    const eventType = event.event || 'Unknown Event';
    const walletAddress = event.data?.recipientAddress || 'N/A';
    const amount = parseFloat(event.data?.amount) || 0;
    const asset = event.data?.asset?.symbol || 'N/A';
    const transactionHash = event.data?.hash || 'N/A';
    const chainRaw = event.data?.blockchain?.name || 'N/A';

    // Normalize and map the chain name
    const chainKey = chainMapping[chainRaw.toLowerCase()];
    if (!chainKey) {
      logger.error(`Unknown chain received in webhook: ${chainRaw}`);
      // Notify admin about the unknown chain
      await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `⚠️ Received deposit on unknown chain: \`${chainRaw}\``);
      return res.status(400).send('Unknown chain.');
    }

    const chain = chainKey;

    if (eventType === 'deposit.success') {
      // Handle initial deposit success event
      if (walletAddress === 'N/A') {
        logger.error('Webhook missing wallet address.');
        return res.status(400).send('Missing wallet address.');
      }

      if (!transactionHash || transactionHash === 'N/A') {
        logger.error('Webhook missing transaction hash.');
        return res.status(400).send('Missing transaction hash.');
      }

      // Check if the deposit already exists
      const existingDeposit = await db.collection('deposits').doc(transactionHash).get();
      if (existingDeposit.exists) {
        logger.info(`Duplicate deposit.success event received for transactionHash: ${transactionHash}. Ignoring.`);
        return res.status(200).send('Duplicate deposit event. Ignored.');
      }

      // Create a new deposit record with status 'pending'
      await db.collection('deposits').doc(transactionHash).set({
        sender: event.data.sender, // Assuming sender is provided
        amount: amount,
        asset: asset,
        transactionHash: transactionHash,
        chain: chainRaw,
        status: 'pending',
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
      });

      logger.info(`Recorded deposit.success for transactionHash: ${transactionHash}`);

      res.status(200).send('Deposit recorded successfully.');
    } else if (eventType === 'deposit.swept.success') {
      // Handle deposit swept success event
      if (walletAddress === 'N/A') {
        logger.error('Webhook missing wallet address.');
        return res.status(400).send('Missing wallet address.');
      }

      if (!transactionHash || transactionHash === 'N/A') {
        logger.error('Webhook missing transaction hash.');
        return res.status(400).send('Missing transaction hash.');
      }

      // Use a Firestore transaction to ensure atomicity
      await db.runTransaction(async (t) => {
        const depositDocRef = db.collection('deposits').doc(transactionHash);
        const depositDoc = await t.get(depositDocRef);

        if (!depositDoc.exists) {
          logger.warn(`deposit.swept.success received without a corresponding deposit.success for transactionHash: ${transactionHash}`);
          // Optionally, you can choose to create a new deposit record here or notify admin
          return;
        }

        const depositData = depositDoc.data();

        if (depositData.status === 'completed') {
          logger.info(`Duplicate deposit.swept.success event received for transactionHash: ${transactionHash}. Ignoring.`);
          return;
        }

        // Update the deposit status to 'completed'
        t.update(depositDocRef, { status: 'completed', sweptAt: admin.firestore.FieldValue.serverTimestamp() });
      });

      // Fetch the updated deposit record
      const updatedDeposit = await db.collection('deposits').doc(transactionHash).get();
      if (!updatedDeposit.exists) {
        logger.error(`Failed to fetch updated deposit for transactionHash: ${transactionHash}`);
        return res.status(500).send('Internal Server Error');
      }

      const depositData = updatedDeposit.data();

      if (depositData.status !== 'completed') {
        logger.warn(`Deposit for transactionHash: ${transactionHash} is not completed yet.`);
        return res.status(200).send('Deposit not completed yet.');
      }

      // Proceed to process the confirmed deposit
      try {
        const userSnapshot = await db.collection('users').where('walletAddresses', 'array-contains', walletAddress).limit(1).get();
        if (userSnapshot.empty) {
          logger.warn(`No user found for wallet address: ${walletAddress}`);
          // Notify admin about the unmatched wallet
          await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `⚠️ No user found for wallet address: \`${walletAddress}\``);
          return res.status(200).send('No user associated with this wallet address.');
        }

        const userDoc = userSnapshot.docs[0];
        const userId = userDoc.id;
        const userData = userDoc.data();
        const wallet = userData.wallets.find(w => w.address === walletAddress);

        if (!wallet || !wallet.bank) {
          // User hasn't linked a bank account
          await bot.telegram.sendMessage(userId, `💰 *Deposit Received:* ${amount} ${asset} on ${chainRaw}.\n\nPlease link a bank account to receive your payout securely.`, { parse_mode: 'Markdown' });
          await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `⚠️ User ${userId} has received a deposit but hasn't linked a bank account.`, { parse_mode: 'Markdown' });
          return res.status(200).send('User has not linked a bank account.');
        }

        // Only support USDC and USDT
        const SUPPORTED_ASSETS = ['USDC', 'USDT'];
        if (!SUPPORTED_ASSETS.includes(asset)) {
          await bot.telegram.sendMessage(userId, `⚠️ *Unsupported Asset Deposited:* ${asset}.\n\nCurrently, only *USDC* and *USDT* are supported. Please contact support if you believe this is an error.`, { parse_mode: 'Markdown' });
          await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `⚠️ User ${userId} deposited unsupported asset: ${asset}.`, { parse_mode: 'Markdown' });
          return res.status(200).send('Unsupported asset.');
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
        const userFirstName = userData.firstName || 'Valued User';

        // Send Successful Deposit Message to User
        const successMessage = await bot.telegram.sendMessage(userId,
          `🎉 *Deposit Successful!*\n\n` +
          `*Reference ID:* \`${referenceId}\`\n` +
          `*Amount Received:* ${amount} ${asset}\n` +
          `*Cash Amount:* NGN ${ngnAmount}\n` +
          `*Bank:* ${bankName}\n` +
          `*Account Name:* ${accountName}\n` +
          `*Account Number:* ****${bankAccount.slice(-4)}\n` +
          `*Network:* ${chainRaw}\n` +
          `*Date:* ${new Date(depositData.timestamp.toDate()).toLocaleString()}\n\n` +
          `Your funds have been successfully deposited. If you have any questions or need further assistance, feel free to [contact our support team](https://t.me/maxcswap).`,
          { parse_mode: 'Markdown' }
        );

        // Enqueue a withdrawal job to process asynchronously
        withdrawalQueue.add({
          userId,
          amount,
          asset,
          chain: chainRaw,
          bankDetails: wallet.bank,
          originalTxHash: transactionHash
        });

        // Notify admin about the successful deposit
        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `✅ *Payment Completed*\n\n` +
          `*User ID:* ${userId}\n` +
          `*Reference ID:* ${referenceId}\n` +
          `*Amount:* ${amount} ${asset}\n` +
          `*Bank:* ${bankName}\n` +
          `*Account Number:* ****${bankAccount.slice(-4)}\n` +
          `*Date:* ${new Date(depositData.timestamp.toDate()).toLocaleString()}\n`, { parse_mode: 'Markdown' });

        res.status(200).send('OK');
      } catch (error) {
        logger.error(`Error processing confirmed deposit for transactionHash ${transactionHash}: ${error.message}`);
        // Update the deposit record with failure status
        await db.collection('deposits').doc(transactionHash).update({
          withdrawalStatus: 'failed',
          withdrawalError: error.message,
          status: 'failed',
          sweptAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        // Notify admin about the failure
        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ Failed to initiate withdrawal for user associated with transactionHash ${transactionHash}: ${error.message}`);
        res.status(500).send('Error initiating withdrawal.');
      }
    } else {
      logger.info(`Unhandled Blockradar event: ${eventType}`);
      res.status(200).send('OK');
    }
  } catch (error) {
    logger.error(`Error processing Blockradar webhook: ${error.message}`);
    res.status(500).send('Error processing webhook');
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ Error processing Blockradar webhook: ${error.message}`);
  }
});

// =================== Paycrest Order Function ===================
// Note: Removed duplicate function definition
async function createPaycrestOrder(userId, amount, token, network, recipientDetails) {
  try {
    // Map to Paycrest network and token
    const paycrestMapping = mapToPaycrest(token, network);
    if (!paycrestMapping) {
      throw new Error('No Paycrest mapping for the selected asset/chain.');
    }

    // Fetch the Paycrest Institution Code
    const bank = bankList.find(b => b.name.toLowerCase() === recipientDetails.bankName.toLowerCase());
    if (!bank || !bank.paycrestInstitutionCode) {
      const errorMsg = `No Paycrest institution code found for bank: ${recipientDetails.bankName}`;
      logger.error(errorMsg);
      // Notify admin about the missing institution code
      await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ ${errorMsg} for user ${userId}.`);
      throw new Error(errorMsg);
    }

    // Construct the recipient object as per Paycrest API
    const recipient = {
      institution: bank.paycrestInstitutionCode, // Use the mapped Paycrest institution code
      accountIdentifier: recipientDetails.accountNumber,
      accountName: recipientDetails.accountName,
      memo: `Payment from DirectPay`,
      providerId: "" // Assuming empty; update if necessary
    };

    // Fetch the current rate from exchangeRates
    const rate = exchangeRates[token];
    if (!rate) {
      throw new Error(`Exchange rate for ${token} not available.`);
    }

    // Construct the payload
    const orderPayload = {
      amount: String(amount), // Token amount as string
      rate: String(rate), // Exchange rate as string from Paycrest Rate API
      network: paycrestMapping.network, // e.g., 'polygon', 'base', etc.
      token: paycrestMapping.token, // 'USDT' or 'USDC'
      recipient: recipient,
      returnAddress: PAYCREST_RETURN_ADDRESS, // Use environment variable
      feePercent: 2, // Example fee percentage
    };

    // Make the API request to Paycrest
    const orderResp = await axios.post('https://api.paycrest.io/v1/sender/orders', orderPayload, {
      headers: {
        'API-Key': PAYCREST_API_KEY,
        'Content-Type': 'application/json'
      }
    });

    // Check if the response is successful
    if (orderResp.data.status !== 'success') {
      throw new Error(`Paycrest order creation failed: ${orderResp.data.message}`);
    }

    // Return the order data
    return orderResp.data.data; // Contains id, amount, token, network, receiveAddress, etc.
  } catch (err) {
    logger.error(`Error creating Paycrest order: ${err.response ? err.response.data.message : err.message}`);
    throw new Error('Failed to create Paycrest order.');
  }
}

// =================== Withdraw from Blockradar Function ===================
// Note: Removed duplicate function definition
async function withdrawFromBlockradar(chain, assetId, address, amount, reference, metadata) {
  try {
    // Ensure the chain exists in the mapping
    const chainKey = chainMapping[chain.toLowerCase()];
    if (!chainKey) {
      throw new Error(`Unsupported or unknown chain: ${chain}`);
    }

    const chainData = chains[chainKey];
    if (!chainData) {
      throw new Error(`Chain data not found for: ${chainKey}`);
    }

    const resp = await axios.post(`https://api.blockradar.co/v1/wallets/${chainData.id}/withdraw`, {
      address,
      amount: String(amount),
      assetId,
      reference,
      metadata
    }, {
      headers: {
        'x-api-key': BLOCKRADAR_API_KEY,
        'Content-Type': 'application/json'
      }
    });
    const data = resp.data;
    if (data.statusCode !== 200) {
      throw new Error(`Blockradar withdrawal error: ${JSON.stringify(data)}`);
    }
    return data;
  } catch (error) {
    logger.error(`Error withdrawing from Blockradar: ${error.response ? error.response.data.message : error.message}`);
    throw error;
  }
}

// =================== Telegram Webhook Setup ===================

// Set Telegram webhook
(async () => {
  try {
    await bot.telegram.setWebhook(TELEGRAM_WEBHOOK_URL);
    logger.info(`Telegram webhook set to ${TELEGRAM_WEBHOOK_URL}`);
  } catch (error) {
    logger.error(`Failed to set Telegram webhook: ${error.message}`);
    process.exit(1);
  }
})();

// Telegram Webhook Handler
app.post(TELEGRAM_WEBHOOK_PATH, (req, res) => {
  bot.handleUpdate(req.body, res);
});

// =================== Express Server ===================
const port = process.env.PORT || 4000;
app.listen(port, () => {
  logger.info(`Webhook server running on port ${port}`);
});

// =================== Graceful Shutdown ===================
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

// =================== Additional Admin Broadcast Handler ===================

// (Handled within broadcast_message_scene above)

// =================== Handle Settings Actions ===================

// (Handled above)

// =================== Admin Actions for Messaging ===================

// (Handled above)

// =================== Greet User Function ===================

// (Already defined once above)

// =================== Handle Unsupported Messages ===================
bot.on('message', async (ctx) => {
  // If not in a scene, provide a generic response
  if (!ctx.session || !ctx.session.isBankLinking) {
    await ctx.reply('⚠️ I did not understand that command. Please select an option from the menu.');
  }
});
