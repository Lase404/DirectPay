// =================== Import Dependencies ===================
const express = require('express');
const { Telegraf, Markup, Scenes, session } = require('telegraf');
const admin = require('firebase-admin');
const axios = require('axios');
const crypto = require('crypto');
const winston = require('winston');
require('dotenv').config();

// =================== Logger Setup ===================
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `[${timestamp}] ${level.toUpperCase()}: ${message}`;
    })
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'bot.log', maxsize: 5242880, maxFiles: 5 }) // 5MB per file, keep last 5 files
  ],
});

// =================== Firebase Setup ===================
const serviceAccount = require('./directpay.json'); // Ensure this file is secured on the server
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
  PAYCREST_RETURN_ADDRESS = "0xYourReturnAddressHere",
  PERSONAL_CHAT_ID,
  PAYSTACK_API_KEY,
  ADMIN_IDS = '', // Comma-separated list of admin User IDs
  WEBHOOK_PATH = '/webhook/telegram',
  WEBHOOK_DOMAIN,
  PORT = 4000,
  BLOCKRADAR_BASE_API_KEY,
  BLOCKRADAR_BNB_API_KEY,
  BLOCKRADAR_POLYGON_API_KEY,
  MAX_WALLETS = 5, // Maximum number of wallets per user
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

// =================== Define Supported Banks ===================
const bankList = [
  { name: 'Access Bank', code: '044', aliases: ['access', 'access bank', 'accessb', 'access bank nigeria'], paycrestInstitutionCode: 'ABNGNGLA' },
  // ... Add all other banks here with their respective codes, aliases, and Paycrest codes
  { name: 'Wema Bank', code: '035', aliases: ['wema', 'wema bank', 'wemab', 'wema bank nigeria'], paycrestInstitutionCode: 'WEMANGLA' },
  { name: 'Kuda Microfinance Bank', code: '50211', aliases: ['kuda', 'kuda bank', 'kudab', 'kuda bank nigeria'], paycrestInstitutionCode: 'KUDANGPC' },
  { name: 'OPay', code: '999992', aliases: ['opay', 'opay nigeria'], paycrestInstitutionCode: 'OPAYNGPC' },
  { name: 'PalmPay', code: '999991', aliases: ['palmpay', 'palmpay nigeria'], paycrestInstitutionCode: 'PALMNGPC' },
  { name: 'Paystack-Titan MFB', code: '999992', aliases: ['paystack', 'paystack mfb', 'paystack-titan mfb'], paycrestInstitutionCode: 'PAYTNGPC' },
  { name: 'Moniepoint MFB', code: '999993', aliases: ['moniepoint', 'moniepoint mfb', 'moniepoint nigeria'], paycrestInstitutionCode: 'MONINGPC' },
  { name: 'Safe Haven MFB', code: '999994', aliases: ['safe haven', 'safe haven mfb', 'safe haven nigeria'], paycrestInstitutionCode: 'SAHVNGPC' },
  // Add more banks as needed
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
    id: 'f4fc4dc4-a0d5-4303-a60b-e58ec1fc6d0a',
    key: BLOCKRADAR_POLYGON_API_KEY,
    apiUrl: 'https://api.blockradar.co/v1/wallets/f4fc4dc4-a0d5-4303-a60b-e58ec1fc6d0a/addresses',
    supportedAssets: ['USDC', 'USDT'],
    network: 'Polygon',
    assets: {
      USDC: 'f348e8e3-e0b4-4704-857e-c274ef000c00',
      USDT: 'c9d57a33-375b-46f7-b694-16e9b498e0e1',
    }
  },
  'BNB Smart Chain': {
    id: '7a844e91-5740-4589-9695-c74411adec7e',
    key: BLOCKRADAR_BNB_API_KEY,
    apiUrl: 'https://api.blockradar.co/v1/wallets/7a844e91-5740-4589-9695-c74411adec7e/addresses',
    supportedAssets: ['USDT', 'USDC'],
    network: 'BNB Smart Chain',
    assets: {
      USDC: 'ff479231-0dbb-4760-b695-e219a50934af',
      USDT: '03a11a51-1422-4ac0-abc0-b2fed75e9fcb',
    }
  }
};

// =================== Chain Mapping ===================
const chainMapping = {
  'base': 'Base',
  'polygon': 'Polygon',
  'bnb smart chain': 'BNB Smart Chain',
  'bnb smartchain': 'BNB Smart Chain',
  'bnb chain': 'BNB Smart Chain',
  'bnb': 'BNB Smart Chain',
  // Add more mappings if necessary
};

// =================== Helper Functions ===================

/**
 * Maps asset and chain name to Paycrest token and network.
 * @param {string} asset - Asset symbol (e.g., 'USDC', 'USDT').
 * @param {string} chainName - Name of the blockchain network.
 * @returns {object|null} - Mapped token and network or null if unsupported.
 */
function mapToPaycrest(asset, chainName) {
  // Only USDC and USDT are supported
  if (!['USDC', 'USDT'].includes(asset)) return null;

  let token = asset.toUpperCase(); // 'USDC' or 'USDT'
  let network;
  const chainKey = chainMapping[chainName.toLowerCase()];
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

/**
 * Calculates NGN payout based on exchange rate.
 * @param {string} asset - Asset symbol.
 * @param {number} amount - Amount of asset.
 * @returns {number} - Calculated NGN amount.
 */
function calculatePayout(asset, amount) {
  const rate = exchangeRates[asset];
  if (!rate) {
    throw new Error(`Unsupported asset received: ${asset}`);
  }
  return parseFloat((amount * rate).toFixed(2)); // Return as number
}

/**
 * Generates a unique reference ID.
 * @returns {string} - Reference ID.
 */
function generateReferenceId() {
  return 'REF-' + Math.random().toString(36).substr(2, 9).toUpperCase();
}

/**
 * Verifies bank account details using Paystack API.
 * @param {string} accountNumber - Bank account number.
 * @param {string} bankCode - Bank code.
 * @returns {object} - Verification result.
 */
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

/**
 * Creates a Paycrest order for off-ramping.
 * @param {string} userId - Telegram user ID.
 * @param {number} amount - Amount of asset.
 * @param {string} token - Asset token (e.g., 'USDC', 'USDT').
 * @param {string} network - Blockchain network.
 * @param {object} recipientDetails - Bank details of the recipient.
 * @param {string} userSendAddress - User's sending address.
 * @returns {object} - Paycrest order data.
 */
async function createPaycrestOrder(userId, amount, token, network, recipientDetails, userSendAddress) {
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

    // Payload
    const orderPayload = {
      amount: String(amount), // Token amount as string
      rate: String(rate), // Exchange rate as string from Paycrest Rate API
      network: paycrestMapping.network, // e.g., 'polygon', 'base', etc.
      token: paycrestMapping.token, // 'USDT' or 'USDC'
      recipient: recipient,
      returnAddress: userSendAddress || PAYCREST_RETURN_ADDRESS, // Use user's send address or default
      feePercent: 2, // Example fee percentage
    };

    // API request
    const orderResp = await axios.post('https://api.paycrest.io/v1/sender/orders', orderPayload, {
      headers: {
        'API-Key': PAYCREST_API_KEY,
        'Content-Type': 'application/json'
      }
    });

    // Check response
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

/**
 * Withdraws assets from Blockradar to a specified address.
 * @param {string} chain - Blockchain network.
 * @param {string} assetId - Asset ID.
 * @param {string} address - Recipient address.
 * @param {number} amount - Amount to withdraw.
 * @param {string} reference - Reference ID.
 * @param {object} metadata - Additional metadata.
 * @returns {object} - Withdrawal response.
 */
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
        'x-api-key': chainData.key, // Use the mapped API key
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

/**
 * Retrieves the user's state from Firestore.
 * @param {string} userId - Telegram user ID.
 * @returns {object} - User state.
 */
async function getUserState(userId) {
  try {
    const userDoc = await db.collection('users').doc(userId).get();
    if (!userDoc.exists) {
      // Initialize user state if not exists with all necessary properties
      await db.collection('users').doc(userId).set({
        firstName: '', // Will be updated upon first interaction
        wallets: [],
        walletAddresses: [],
        hasReceivedDeposit: false,
        awaitingBroadcastMessage: false, // For admin broadcast
      });
      return {
        firstName: '',
        wallets: [],
        walletAddresses: [],
        hasReceivedDeposit: false,
        awaitingBroadcastMessage: false,
      };
    } else {
      const data = userDoc.data();
      // Ensure all properties are defined, else set default values
      return {
        firstName: data.firstName || '',
        wallets: data.wallets || [],
        walletAddresses: data.walletAddresses || [],
        hasReceivedDeposit: data.hasReceivedDeposit || false,
        awaitingBroadcastMessage: data.awaitingBroadcastMessage || false,
      };
    }
  } catch (error) {
    logger.error(`Error getting user state for ${userId}: ${error.message}`);
    throw error;
  }
}

/**
 * Updates the user's state in Firestore.
 * @param {string} userId - Telegram user ID.
 * @param {object} newState - New state to update.
 */
async function updateUserState(userId, newState) {
  try {
    await db.collection('users').doc(userId).update(newState);
  } catch (error) {
    logger.error(`Error updating user state for ${userId}: ${error.message}`);
    throw error;
  }
}

/**
 * Generates a new wallet address for the specified chain.
 * @param {string} chain - Blockchain network.
 * @returns {string} - Wallet address.
 */
async function generateWallet(chain) {
  try {
    const chainKey = chainMapping[chain.toLowerCase()];
    if (!chainKey) {
      throw new Error(`Unsupported chain: ${chain}`);
    }

    const chainData = chains[chainKey];
    if (!chainData) {
      throw new Error(`Chain data not found for: ${chainKey}`);
    }

    const response = await axios.post(
      chainData.apiUrl,
      { name: `DirectPay_User_Wallet_${chain}` },
      { headers: { 'x-api-key': chainData.key } }
    );

    const walletAddress = response.data.data.address;
    if (!walletAddress) {
      throw new Error('Wallet address not returned from Blockradar.');
    }
    return walletAddress;
  } catch (error) {
    logger.error(`Error generating wallet for ${chain}: ${error.response ? error.response.data.message : error.message}`);
    throw new Error(`Error generating wallet for ${chain}: ${error.response ? error.response.data.message : error.message}`);
  }
}

/**
 * Generates a transaction receipt message.
 * @param {object} txData - Transaction data.
 * @returns {string} - Receipt message.
 */
function generateReceipt(txData) {
  let receiptMessage = `🧾 *Transaction Receipt*\n\n`;
  receiptMessage += `*Reference ID:* \`${txData.referenceId || 'N/A'}\`\n`;
  receiptMessage += `*Amount:* ${txData.amount || 'N/A'} ${txData.asset || 'N/A'}\n`;
  receiptMessage += `*Status:* ${txData.status || 'Pending'}\n`;
  receiptMessage += `*Exchange Rate:* ₦${exchangeRates[txData.asset] || 'N/A'} per ${txData.asset || 'N/A'}\n`;
  receiptMessage += `*Date:* ${txData.timestamp ? new Date(txData.timestamp).toLocaleString() : 'N/A'}\n`;
  receiptMessage += `*Chain:* ${txData.chain || 'N/A'}\n`;

  return receiptMessage;
}

// =================== Define Scenes ===================

/**
 * =================== Bank Linking Scene ===================
 */
const bankLinkingScene = new Scenes.WizardScene(
  'bank_linking_scene',
  // Step 1: Enter Bank Name
  async (ctx) => {
    const userId = ctx.from.id.toString();
    const walletIndex = ctx.session.walletIndex;

    if (walletIndex === undefined || walletIndex === null) {
      await ctx.replyWithMarkdown('⚠️ No wallet selected for linking. Please generate a wallet first.');
      return ctx.scene.leave();
    }

    ctx.session.bankData = {};
    ctx.session.bankData.step = 1;
    await ctx.replyWithMarkdown('🏦 Please enter your bank name (e.g., Access Bank):');
    return ctx.wizard.next();
  },
  // Step 2: Enter Account Number
  async (ctx) => {
    const userId = ctx.from.id.toString();
    const input = ctx.message.text.trim();
    logger.info(`User ${userId} entered bank name: ${input}`);

    const bankNameInput = input.toLowerCase();
    const bank = bankList.find((b) => b.aliases.includes(bankNameInput));

    if (!bank) {
      await ctx.replyWithMarkdown('❌ Invalid bank name. Please enter a valid bank name from our supported list:\n\n' + bankList.map(b => `• ${b.name}`).join('\n'));
      return; // Stay on the same step
    }

    ctx.session.bankData.bankName = bank.name;
    ctx.session.bankData.bankCode = bank.code;
    ctx.session.bankData.step = 2;

    await ctx.replyWithMarkdown('🔢 Please enter your 10-digit bank account number:');
    return ctx.wizard.next();
  },
  // Step 3: Verify Account Number
  async (ctx) => {
    const userId = ctx.from.id.toString();
    const input = ctx.message.text.trim();
    logger.info(`User ${userId} entered account number: ${input}`);

    if (!/^\d{10}$/.test(input)) {
      await ctx.replyWithMarkdown('❌ Invalid account number. Please enter a valid 10-digit account number:');
      return; // Stay on the same step
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
          [Markup.button.callback('❌ Cancel Linking', 'cancel_bank_linking')],
        ])
      );
      return ctx.wizard.next();
    } catch (error) {
      logger.error(`Error verifying bank account for user ${userId}: ${error.message}`);
      await ctx.replyWithMarkdown('❌ Failed to verify your bank account. Please ensure your details are correct or try again later.');
      return ctx.scene.leave();
    }
  },
  // Step 4: Confirmation (Handled by action handlers)
  async (ctx) => {
    // This step is intentionally left blank as confirmation is handled by action handlers
    return;
  }
);

// Handle Confirmation Actions Within the Bank Linking Scene
bankLinkingScene.action('confirm_bank_yes', async (ctx) => {
  const userId = ctx.from.id.toString();
  const bankData = ctx.session.bankData;
  const walletIndex = ctx.session.walletIndex;

  try {
    let userState = await getUserState(userId);

    if (walletIndex === undefined || walletIndex === null || !userState.wallets[walletIndex]) {
      await ctx.replyWithMarkdown('⚠️ No wallet selected for linking. Please generate a wallet first.');
      await ctx.answerCbQuery();
      return ctx.scene.leave();
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

    await ctx.replyWithMarkdown(confirmationMessage, getMainMenu(true, true));

    // Log to Admin
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `🔗 User ${userId} linked a bank account:\n\n` +
      `*Account Name:* ${userState.wallets[walletIndex].bank.accountName}\n` +
      `*Bank Name:* ${userState.wallets[walletIndex].bank.bankName}\n` +
      `*Account Number:* ****${userState.wallets[walletIndex].bank.accountNumber.slice(-4)}`, { parse_mode: 'Markdown' });
    logger.info(`User ${userId} linked a bank account: ${JSON.stringify(userState.wallets[walletIndex].bank)}`);

    // Acknowledge the Callback to Remove Loading State
    await ctx.answerCbQuery();
    ctx.scene.leave();
  } catch (error) {
    logger.error(`Error in confirm_bank_yes handler for user ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('❌ An error occurred while confirming your bank details. Please try again later.');
    await ctx.answerCbQuery();
    ctx.scene.leave();
  }
});

bankLinkingScene.action('confirm_bank_no', async (ctx) => {
  await ctx.replyWithMarkdown('⚠️ Let\'s try again.');

  // Restart the scene
  await ctx.scene.reenter();

  // Acknowledge the Callback to Remove Loading State
  await ctx.answerCbQuery();
});

bankLinkingScene.action('cancel_bank_linking', async (ctx) => {
  await ctx.replyWithMarkdown('❌ Bank linking process has been canceled.');

  // Clean Up Session Variables
  delete ctx.session.walletIndex;
  delete ctx.session.bankData;
  delete ctx.session.processType;

  // Acknowledge the Callback to Remove Loading State
  await ctx.answerCbQuery();
  ctx.scene.leave();
});

/**
 * =================== Send Message Scene ===================
 */
const sendMessageScene = new Scenes.WizardScene(
  'send_message_scene',
  // Step 1: Enter User ID
  async (ctx) => {
    await ctx.replyWithMarkdown('📩 Please enter the User ID you want to message:');
    return ctx.wizard.next();
  },
  // Step 2: Enter Message Content
  async (ctx) => {
    const userIdToMessage = ctx.message.text.trim();

    // Validate User ID
    if (!/^\d{5,15}$/.test(userIdToMessage)) {
      await ctx.replyWithMarkdown('❌ Invalid User ID. Please enter a valid numeric User ID (5-15 digits):');
      return;
    }

    // Check if User Exists
    const userDoc = await db.collection('users').doc(userIdToMessage).get();
    if (!userDoc.exists) {
      await ctx.replyWithMarkdown('❌ User ID not found. Please ensure the User ID is correct or try another one:');
      return;
    }

    ctx.session.userIdToMessage = userIdToMessage;
    await ctx.replyWithMarkdown('📝 Please enter the message you want to send to the user. You can also attach an image (receipt) with your message:');
    return ctx.wizard.next();
  },
  // Step 3: Send Message
  async (ctx) => {
    const userIdToMessage = ctx.session.userIdToMessage;
    const adminUserId = ctx.from.id.toString();

    if (ctx.message.photo) {
      // Handle Photo Message
      const photoArray = ctx.message.photo;
      const highestResolutionPhoto = photoArray[photoArray.length - 1];
      const fileId = highestResolutionPhoto.file_id;
      const caption = ctx.message.caption || '';

      try {
        await bot.telegram.sendPhoto(userIdToMessage, fileId, { caption: caption, parse_mode: 'Markdown' });
        await ctx.replyWithMarkdown('✅ Photo message sent successfully.');
        logger.info(`Admin ${adminUserId} sent photo message to user ${userIdToMessage}. Caption: ${caption}`);
      } catch (error) {
        logger.error(`Error sending photo to user ${userIdToMessage}: ${error.message}`);
        await ctx.replyWithMarkdown('⚠️ Error sending photo. Please ensure the User ID is correct and the user has not blocked the bot.');
      }
    } else if (ctx.message.text) {
      // Handle Text Message
      const messageContent = ctx.message.text.trim();

      if (!messageContent) {
        await ctx.reply('❌ Message content cannot be empty. Please enter a valid message:');
        return;
      }

      try {
        await bot.telegram.sendMessage(userIdToMessage, `📩 *Message from Admin:*\n\n${messageContent}`, { parse_mode: 'Markdown' });
        await ctx.replyWithMarkdown('✅ Text message sent successfully.');
        logger.info(`Admin ${adminUserId} sent text message to user ${userIdToMessage}: ${messageContent}`);
      } catch (error) {
        logger.error(`Error sending message to user ${userIdToMessage}: ${error.message}`);
        await ctx.replyWithMarkdown('⚠️ Error sending message. Please ensure the User ID is correct and the user has not blocked the bot.');
      }
    } else {
      await ctx.reply('❌ Unsupported message type. Please send text or a photo (receipt).');
    }

    // Reset Session Variables and Leave the Scene
    delete ctx.session.userIdToMessage;
    ctx.scene.leave();
  }
);

/**
 * =================== Receipt Generation Scene ===================
 */
const receiptGenerationScene = new Scenes.WizardScene(
  'receipt_generation_scene',
  // Step 1: Select Wallet
  async (ctx) => {
    const userId = ctx.from.id.toString();
    const userState = await getUserState(userId);

    if (userState.wallets.length === 0) {
      await ctx.replyWithMarkdown('❌ You have no wallets. Please generate a wallet first using the "💼 Generate Wallet" option.');
      return ctx.scene.leave();
    }

    // If only one wallet, proceed to generate receipt
    if (userState.wallets.length === 1) {
      ctx.session.walletIndex = 0;
      return ctx.wizard.next();
    }

    // Multiple wallets: Prompt user to select one
    let keyboard = userState.wallets.map((wallet, index) => [
      Markup.button.callback(`Wallet ${index + 1} - ${wallet.chain}`, `select_receipt_wallet_${index}`)
    ]);
    await ctx.reply('Please select the wallet for which you want to generate a transaction receipt:', Markup.inlineKeyboard(keyboard));
    return ctx.wizard.next();
  },
  // Step 2: Generate Receipt
  async (ctx) => {
    const userId = ctx.from.id.toString();
    let walletIndex;

    if (ctx.session.walletIndex === undefined || ctx.session.walletIndex === null) {
      const match = ctx.match && ctx.match[1];
      walletIndex = parseInt(match, 10);

      if (isNaN(walletIndex)) {
        await ctx.replyWithMarkdown('⚠️ Invalid wallet selection. Please try again.');
        return ctx.wizard.back();
      }

      ctx.session.walletIndex = walletIndex;
    } else {
      walletIndex = ctx.session.walletIndex;
    }

    try {
      const userState = await getUserState(userId);
      const wallet = userState.wallets[walletIndex];

      if (!wallet) {
        throw new Error('Wallet not found.');
      }

      // Fetch transactions related to this wallet
      const transactionsSnapshot = await db.collection('transactions')
        .where('walletAddress', '==', wallet.address)
        .orderBy('timestamp', 'desc')
        .limit(10)
        .get();

      if (transactionsSnapshot.empty) {
        return ctx.replyWithMarkdown('You have no transactions for this wallet.');
      }

      let receiptMessage = `🧾 *Transaction Receipt for Wallet ${walletIndex + 1} - ${wallet.chain}*\n\n`;
      transactionsSnapshot.forEach((doc) => {
        const tx = doc.data();
        receiptMessage += `*Reference ID:* \`${tx.referenceId || 'N/A'}\`\n`;
        receiptMessage += `*Amount:* ${tx.amount || 'N/A'} ${tx.asset || 'N/A'}\n`;
        receiptMessage += `*Status:* ${tx.status || 'Pending'}\n`;
        receiptMessage += `*Exchange Rate:* ₦${exchangeRates[tx.asset] || 'N/A'} per ${tx.asset || 'N/A'}\n`;
        receiptMessage += `*Date:* ${tx.timestamp ? new Date(tx.timestamp).toLocaleString() : 'N/A'}\n`;
        receiptMessage += `*Chain:* ${tx.chain || 'N/A'}\n\n`;
      });

      await ctx.replyWithMarkdown(receiptMessage);
      ctx.scene.leave();
    } catch (error) {
      logger.error(`Error generating receipt for user ${userId}: ${error.message}`);
      await ctx.replyWithMarkdown('⚠️ An error occurred while generating the receipt. Please try again later.');
      ctx.scene.leave();
    }
  }
);

// =================== Register Scenes with Stage ===================
const stage = new Scenes.Stage();
stage.register(bankLinkingScene, sendMessageScene, receiptGenerationScene);

// =================== Apply Middlewares ===================
bot.use(session());
bot.use(stage.middleware());

// =================== Exchange Rate Fetching ===================
const SUPPORTED_ASSETS = ['USDC', 'USDT'];
let exchangeRates = {
  USDC: 0,
  USDT: 0
};

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
const getMainMenu = (walletExists, hasBankLinked) =>
  Markup.keyboard([
    [walletExists ? '💼 View Wallet' : '💼 Generate Wallet', hasBankLinked ? '⚙️ Settings' : '🏦 Link Bank Account'],
    ['💰 Transactions', 'ℹ️ Support', '📘 Learn About Base'],
    ['📈 View Current Rates'], // Added Refresh Rates Button
  ]).resize();

// =================== Check if User is Admin ===================
const isAdmin = (userId) => ADMIN_IDS.split(',').map(id => id.trim()).includes(userId.toString());

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
  const userId = ctx.from.id.toString();
  const selectedChainRaw = ctx.match[1]; // e.g., 'Base', 'Polygon', 'BNB Smart Chain'

  // Normalize and map the selected chain
  const selectedChainKey = chainMapping[selectedChainRaw.toLowerCase()];
  if (!selectedChainKey) {
    await ctx.replyWithMarkdown('⚠️ Invalid network selection. Please try again.');
    return ctx.answerCbQuery(); // Acknowledge the callback to remove loading state
  }

  const chain = selectedChainKey;

  // Acknowledge the Callback to Remove Loading State
  await ctx.answerCbQuery();

  // Inform User That Wallet Generation Has Started
  const generatingMessage = await ctx.replyWithMarkdown(`🔄 Generating Wallet for *${chain}*... Please wait a moment.`);

  try {
    const walletAddress = await generateWallet(chain);

    // Fetch Updated User State
    const userState = await getUserState(userId);

    if (userState.wallets.length >= MAX_WALLETS) {
      await ctx.replyWithMarkdown(`⚠️ You cannot generate more than ${MAX_WALLETS} wallets.`);
      await ctx.deleteMessage(generatingMessage.message_id);
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
    ctx.session.walletIndex = newWalletIndex;

    // Delete the Generating Message
    await ctx.deleteMessage(generatingMessage.message_id);

    // Enter the Bank Linking Wizard Scene Immediately
    await ctx.scene.enter('bank_linking_scene');
  } catch (error) {
    logger.error(`Error generating wallet for user ${userId} on ${chain}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ There was an issue generating your wallet. Please try again later.');
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ Error generating wallet for user ${userId}: ${error.message}`, { parse_mode: 'Markdown' });
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
    const totalPages = Math.ceil(userState.wallets.length / pageSize);
    ctx.session.walletsPage = 1; // Initialize to first page

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

    const { message, inlineKeyboard } = generateWalletPage(ctx.session.walletsPage);
    await ctx.replyWithMarkdown(message, inlineKeyboard);
  } catch (error) {
    logger.error(`Error handling View Wallet for user ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred while fetching your wallets. Please try again later.');
  }
});

// Handle Wallet Page Navigation
bot.action(/wallet_page_(\d+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const requestedPage = parseInt(ctx.match[1], 10);

  try {
    const userState = await getUserState(userId);
    const pageSize = 5;
    const totalPages = Math.ceil(userState.wallets.length / pageSize);

    if (requestedPage < 1 || requestedPage > totalPages) {
      return ctx.answerCbQuery('⚠️ Invalid page number.', { show_alert: true });
    }

    ctx.session.walletsPage = requestedPage;

    const { message, inlineKeyboard } = generateWalletPage(requestedPage, userState, pageSize, totalPages);
    await ctx.editMessageText(message, { parse_mode: 'Markdown', reply_markup: inlineKeyboard.reply_markup });
    ctx.answerCbQuery(); // Acknowledge the callback
  } catch (error) {
    logger.error(`Error navigating wallet pages for user ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred while navigating wallets. Please try again later.');
    ctx.answerCbQuery();
  }
});

/**
 * Generates a wallet page message.
 * @param {number} page - Current page number.
 * @param {object} userState - User state data.
 * @param {number} pageSize - Number of wallets per page.
 * @param {number} totalPages - Total number of pages.
 * @returns {object} - Message and inline keyboard.
 */
function generateWalletPage(page, userState, pageSize, totalPages) {
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
}

// =================== Settings Handler ===================
bot.hears('⚙️ Settings', async (ctx) => {
  await ctx.reply('⚙️ *Settings Menu*', getSettingsMenu());
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

// =================== Handle Settings Menu Actions ===================
bot.action(/settings_(.+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const action = ctx.match[1];

  try {
    switch (action) {
      case 'generate_wallet':
        await ctx.replyWithMarkdown('📈 *Current Exchange Rates*:\n\n' + SUPPORTED_ASSETS.map(asset => `• *${asset}*: ₦${exchangeRates[asset]}`).join('\n') + '\n\nThese rates will be applied during your deposits and payouts.');
        await ctx.reply('📂 *Select the network for which you want to generate a wallet:*', Markup.inlineKeyboard([
          [Markup.button.callback('Base', 'generate_wallet_Base')],
          [Markup.button.callback('Polygon', 'generate_wallet_Polygon')],
          [Markup.button.callback('BNB Smart Chain', 'generate_wallet_BNB Smart Chain')],
        ]));
        break;

      case 'edit_bank':
        const userState = await getUserState(userId);
        if (userState.wallets.length === 0) {
          await ctx.replyWithMarkdown('❌ You have no wallets. Please generate a wallet first using the "💼 Generate Wallet" option.');
          break;
        }

        // If only one wallet, proceed to edit bank
        if (userState.wallets.length === 1) {
          ctx.session.walletIndex = 0;
          await ctx.scene.enter('bank_linking_scene');
          break;
        }

        // Multiple wallets, prompt user to select which wallet to edit
        let keyboard = userState.wallets.map((wallet, index) => [
          Markup.button.callback(`Wallet ${index + 1} - ${wallet.chain}`, `select_wallet_edit_bank_${index}`)
        ]);
        await ctx.reply('Please select the wallet for which you want to edit the bank details:', Markup.inlineKeyboard(keyboard));
        break;

      case 'support':
        await ctx.replyWithMarkdown('🛠️ *Support Section*\n\nSelect an option below:', Markup.inlineKeyboard([
          [Markup.button.callback('❓ How It Works', 'support_how_it_works')],
          [Markup.button.callback('⚠️ Transaction Not Received', 'support_not_received')],
          [Markup.button.callback('💬 Contact Support', 'support_contact')],
        ]));
        break;

      case 'generate_receipt':
        const userStateReceipt = await getUserState(userId);
        if (userStateReceipt.wallets.length === 0) {
          await ctx.replyWithMarkdown('❌ You have no wallets. Please generate a wallet first using the "💼 Generate Wallet" option.');
          break;
        }

        // Prompt user to select which wallet to generate receipt for
        let receiptKeyboard = userStateReceipt.wallets.map((wallet, index) => [
          Markup.button.callback(`Wallet ${index + 1} - ${wallet.chain}`, `select_receipt_wallet_${index}`)
        ]);
        await ctx.reply('Please select the wallet for which you want to generate a transaction receipt:', Markup.inlineKeyboard(receiptKeyboard));
        break;

      case 'back_main':
        await greetUser(ctx);
        break;

      default:
        await ctx.replyWithMarkdown('⚠️ Unknown settings action. Please select a valid option.');
    }

    // Acknowledge the callback
    await ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error handling settings action "${action}" for user ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred while processing your request. Please try again later.');
    await ctx.answerCbQuery();
  }
});

// Handle Wallet Selection for Editing Bank Details
bot.action(/select_wallet_edit_bank_(\d+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const walletIndex = parseInt(ctx.match[1], 10);

  if (isNaN(walletIndex)) {
    await ctx.replyWithMarkdown('⚠️ Invalid wallet selection. Please try again.');
    return ctx.answerCbQuery();
  }

  ctx.session.walletIndex = walletIndex;
  await ctx.scene.enter('bank_linking_scene');
  ctx.answerCbQuery();
});

// Handle "💬 Support" in Settings
bot.action('settings_support', async (ctx) => {
  await ctx.replyWithMarkdown('🛠️ *Support Section*\n\nSelect an option below:', Markup.inlineKeyboard([
    [Markup.button.callback('❓ How It Works', 'support_how_it_works')],
    [Markup.button.callback('⚠️ Transaction Not Received', 'support_not_received')],
    [Markup.button.callback('💬 Contact Support', 'support_contact')],
  ]));
});

// Handle "🔙 Back to Main Menu" in Settings
bot.action('settings_back_main', async (ctx) => {
  await greetUser(ctx);
  ctx.answerCbQuery();
});

// =================== Support Handlers ===================
const detailedTutorials = {
  how_it_works: `
**📘 How DirectPay Works**

1. **Generate Your Wallet:**
   - Navigate to the "💼 Generate Wallet" option.
   - Select your preferred network (Base, Polygon, BNB Smart Chain).
   - Receive a unique wallet address where you can receive crypto payments.

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
Visit the support section or contact our support team at [@maxcswap](https://t.me/maxcswap) for any assistance.
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
   - If the issue persists after following the above steps, reach out to our support team at [@maxswap](https://t.me/maxcswap) with your transaction details for further assistance.
`,
  link_bank_tutorial: `
**🏦 How to Edit Your Bank Account**

*Editing an Existing Bank Account:*

1. **Navigate to Bank Editing:**
   - Click on "⚙️ Settings" > "✏️ Edit Linked Bank Details" from the main menu.

2. **Select the Wallet:**
   - Choose the wallet whose bank account you wish to edit.

3. **Provide New Bank Details:**
   - Enter the updated bank name or account number as required.

4. **Verify Changes:**
   - Confirm the updated account holder name.

5. **Completion:**
   - Your bank account details have been updated successfully.
`,
};

// =================== Learn About Base Handler ===================
bot.hears(/📘\s*Learn About Base/i, async (ctx) => {
  await sendBaseContent(ctx, 0, true);
});

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
 * Sends Base content with pagination.
 * @param {TelegrafContext} ctx - Telegraf context.
 * @param {number} index - Current page index.
 * @param {boolean} isNew - Indicates if it's a new message or an edit.
 */
async function sendBaseContent(ctx, index, isNew = true) {
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
    ctx.session.baseMessageId = sentMessage.message_id;
  } else {
    try {
      await ctx.editMessageText(`**${content.title}**\n\n${content.text}`, {
        parse_mode: 'Markdown',
        reply_markup: inlineKeyboard.reply_markup,
      });
    } catch (error) {
      // If editing message fails, send a new message and update session
      const sentMessage = await ctx.replyWithMarkdown(`**${content.title}**\n\n${content.text}`, inlineKeyboard);
      ctx.session.baseMessageId = sentMessage.message_id;
    }
  }
}

// Base Content Pagination
bot.action(/base_page_(\d+)/, async (ctx) => {
  const index = parseInt(ctx.match[1], 10);
  if (isNaN(index) || index < 0 || index >= baseContent.length) {
    return ctx.answerCbQuery('⚠️ Invalid page number.', { show_alert: true });
  }
  await sendBaseContent(ctx, index, false);
  ctx.answerCbQuery(); // Acknowledge the callback
});

// Exit Base Content
bot.action('exit_base', async (ctx) => {
  // Delete the message and clear session
  if (ctx.session.baseMessageId) {
    await ctx.deleteMessage(ctx.session.baseMessageId).catch(() => {});
    ctx.session.baseMessageId = null;
  }
  await ctx.replyWithMarkdown('Thank you for learning about Base!');
  ctx.answerCbQuery();
});

// =================== Support Handlers ===================
bot.hears(/ℹ️\s*Support/i, async (ctx) => {
  await ctx.replyWithMarkdown('🛠️ *Support Section*\n\nSelect an option below:', Markup.inlineKeyboard([
    [Markup.button.callback('❓ How It Works', 'support_how_it_works')],
    [Markup.button.callback('⚠️ Transaction Not Received', 'support_not_received')],
    [Markup.button.callback('💬 Contact Support', 'support_contact')],
  ]));
});

// Support Actions
bot.action('support_how_it_works', async (ctx) => {
  await ctx.replyWithMarkdown(detailedTutorials.how_it_works);
  ctx.answerCbQuery();
});

bot.action('support_not_received', async (ctx) => {
  await ctx.replyWithMarkdown(detailedTutorials.transaction_guide);
  ctx.answerCbQuery();
});

bot.action('support_contact', async (ctx) => {
  await ctx.replyWithMarkdown('You can contact our support team at [@your_support_username](https://t.me/your_support_username).');
  ctx.answerCbQuery();
});

// =================== Transactions Handler ===================
bot.hears(/💰\s*Transactions/i, async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    const pageSize = 5; // Number of transactions per page
    const userState = await getUserState(userId);
    const totalPages = Math.ceil(userState.wallets.length / pageSize) || 1;
    ctx.session.transactionsPage = 1; // Initialize to first page

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
        message += `• *Chain:* ${tx.chain || 'N/A'}\n\n`;
      });

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

    const { message, inlineKeyboard } = generateTransactionPage(ctx.session.transactionsPage, userState, pageSize, totalPages);
    await ctx.replyWithMarkdown(message, inlineKeyboard);
  } catch (error) {
    logger.error(`Error fetching transactions for user ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ Unable to fetch transactions. Please try again later.');
  }
});

// Transaction Page Navigation
bot.action(/transaction_page_(\d+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const requestedPage = parseInt(ctx.match[1], 10);

  try {
    const pageSize = 5;
    const userState = await getUserState(userId);
    const totalPages = Math.ceil(userState.wallets.length / pageSize) || 1;

    if (requestedPage < 1 || requestedPage > totalPages) {
      return ctx.answerCbQuery('⚠️ Invalid page number.', { show_alert: true });
    }

    ctx.session.transactionsPage = requestedPage;

    const { message, inlineKeyboard } = generateTransactionPage(requestedPage, userState, pageSize, totalPages);
    await ctx.editMessageText(message, { parse_mode: 'Markdown', reply_markup: inlineKeyboard.reply_markup });
    ctx.answerCbQuery(); // Acknowledge the callback
  } catch (error) {
    logger.error(`Error navigating transaction pages for user ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred while navigating transactions. Please try again later.');
    ctx.answerCbQuery();
  }
});

/**
 * Generates a transaction page message.
 * @param {number} page - Current page number.
 * @param {object} userState - User state data.
 * @param {number} pageSize - Number of transactions per page.
 * @param {number} totalPages - Total number of pages.
 * @returns {object} - Message and inline keyboard.
 */
function generateTransactionPage(page, userState, pageSize, totalPages) {
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
    message += `• *Chain:* ${tx.chain || 'N/A'}\n\n`;
  });

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
}

// =================== Admin Panel ===================

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

  // Removed the inactivity timeout as per user request
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
  const userId = ctx.from.id.toString();
  const action = ctx.match[1];

  if (!isAdmin(userId)) {
    return ctx.reply('⚠️ Unauthorized access.');
  }

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
          message += `*Date:* ${tx.timestamp ? new Date(tx.timestamp).toLocaleString() : 'N/A'}\n\n`;
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
              `*Reference ID:* \`${txData.referenceId || 'N/A'}\`\n` +
              `*Amount Paid:* ${txData.amount} ${txData.asset}\n` +
              `*Bank:* ${txData.bankDetails.bankName || 'N/A'}\n` +
              `*Account Name:* ${accountName}\n` +
              `*Account Number:* ****${txData.bankDetails.accountNumber.slice(-4)}\n` +
              `*Payout (NGN):* ₦${payout}\n\n` +
              `🔹 *Chain:* ${txData.chain}\n` +
              `*Date:* ${new Date(txData.timestamp).toLocaleString()}\n\n` +
              `Thank you for using *DirectPay*! Your funds have been securely transferred to your bank account.`,
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

        // Back to main menu
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

        // Initiate broadcast process
        await ctx.reply('📢 Please enter the message you want to broadcast to all users. You can also attach an image (receipt) with your message:');
        // Implement a separate scene or handler if needed
        // For simplicity, this example does not implement it
        await ctx.answerCbQuery();
      } catch (error) {
        logger.error(`Error initiating broadcast message: ${error.message}`);
        await ctx.replyWithMarkdown('⚠️ An error occurred while initiating the broadcast. Please try again later.');
        ctx.answerCbQuery();
      }
      break;

    case 'back_to_main':
      // Return to the main menu
      await greetUser(ctx);
      break;

    default:
      await ctx.replyWithMarkdown('⚠️ Unknown action. Please select an option from the menu.', { parse_mode: 'Markdown' });
  }
});

// Handle Admin Panel Back to Main
bot.action('admin_back_to_main', async (ctx) => {
  await greetUser(ctx);
});

// =================== Additional Enhancements ===================

/**
 * =================== Feedback Scene ===================
 */
const feedbackScene = new Scenes.WizardScene(
  'feedback_scene',
  // Step 1: Collect Feedback
  async (ctx) => {
    if (ctx.session.awaitingFeedback) {
      ctx.session.awaitingFeedback = false; // Reset the flag
      ctx.session.feedback = ''; // Initialize feedback

      await ctx.replyWithMarkdown('📝 Please enter your feedback below:');
      return ctx.wizard.next();
    } else {
      await ctx.replyWithMarkdown('❗️ Unexpected action. Please try again.');
      return ctx.scene.leave();
    }
  },
  // Step 2: Confirm and Forward Feedback
  async (ctx) => {
    const userId = ctx.from.id.toString();
    const feedback = ctx.message.text.trim();

    if (!feedback) {
      await ctx.replyWithMarkdown('❌ Feedback cannot be empty. Please enter your feedback:');
      return;
    }

    try {
      // Store feedback in Firebase
      const userDocRef = db.collection('users').doc(userId);
      await userDocRef.update({
        lastFeedback: feedback,
        lastFeedbackTimestamp: admin.firestore.FieldValue.serverTimestamp(),
      });

      // Forward feedback to admin with username
      const username = ctx.from.username ? `@${ctx.from.username}` : 'N/A';
      const firstName = ctx.from.first_name || 'N/A';
      const lastRating = ctx.session.lastRating || 'N/A';

      await bot.telegram.sendMessage(
        PERSONAL_CHAT_ID,
        `📝 *User Feedback*\n\n` +
        `*Username:* ${username}\n` +
        `*First Name:* ${firstName}\n` +
        `*User ID:* ${userId}\n\n` +
        `*Rating:* ${lastRating} star${lastRating === 1 ? '' : 's'}\n` +
        `*Feedback:* ${feedback}`,
        { parse_mode: 'Markdown' }
      );

      // Acknowledge feedback to user
      await ctx.replyWithMarkdown('✅ Thank you for your valuable feedback! We strive to improve our service based on your input.');

      // Clear session variables
      delete ctx.session.lastRating;
      delete ctx.session.awaitingFeedback;
      delete ctx.session.feedback;

      return ctx.scene.leave();
    } catch (error) {
      logger.error(`Error handling user feedback for user ${userId}: ${error.message}`);
      await ctx.replyWithMarkdown('⚠️ An error occurred while recording your feedback. Please try again later.');
      return ctx.scene.leave();
    }
  }
);

// Register the Feedback Scene with the Stage
stage.register(feedbackScene);

/**
 * =================== Broadcast Message Handler ===================
 * Note: Implementation depends on further requirements.
 * For simplicity, it's not implemented in this example.
 */

// Handle Incoming Feedback Messages
bot.on('text', async (ctx, next) => {
  if (ctx.session.awaitingFeedback) {
    // Enter the feedback scene
    await ctx.scene.enter('feedback_scene');
  } else {
    // Proceed with other handlers
    return next();
  }
});

// =================== Telegraf Scenes: Rating Action Handlers ===================

// Handle 1-star rating
bot.action('rate_1', async (ctx) => {
  await handleUserRating(ctx, 1);
});

// Handle 2-star rating
bot.action('rate_2', async (ctx) => {
  await handleUserRating(ctx, 2);
});

// Handle 3-star rating
bot.action('rate_3', async (ctx) => {
  await handleUserRating(ctx, 3);
});

// Handle 4-star rating
bot.action('rate_4', async (ctx) => {
  await handleUserRating(ctx, 4);
});

// Handle 5-star rating
bot.action('rate_5', async (ctx) => {
  await handleUserRating(ctx, 5);
});

/**
 * Handles user rating selection.
 * @param {TelegrafContext} ctx - Telegraf context.
 * @param {number} rating - User's rating (1-5).
 */
async function handleUserRating(ctx, rating) {
  const userId = ctx.from.id.toString();

  try {
    // Acknowledge the button press
    await ctx.answerCbQuery();

    // Store the rating in Firebase
    const userDocRef = db.collection('users').doc(userId);
    await userDocRef.update({
      lastRating: rating,
      lastRatingTimestamp: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Store the rating in session for later use
    ctx.session.lastRating = rating;

    // Ask for feedback
    await ctx.replyWithMarkdown(`⭐️ Thank you for rating us *${rating} star${rating > 1 ? 's' : ''}*! Please share any additional feedback you have about our service:`);

    // Set a flag to indicate that the next message is feedback
    ctx.session.awaitingFeedback = true;
  } catch (error) {
    logger.error(`Error handling user rating for user ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred while recording your rating. Please try again later.');
  }
}

// =================== Blockradar Webhook Handler ===================

/**
 * =================== Blockradar Webhook Handler ===================
 */
app.post('/webhook/blockradar', express.json(), async (req, res) => {
  const parsedBody = req.body;

  // Log the entire body for debugging
  logger.info(`Blockradar webhook body: ${JSON.stringify(parsedBody)}`);

  // Adjust based on actual payload structure
  const event = parsedBody.type || parsedBody.event;
  logger.info(`Received Blockradar event: ${event}`);

  if (!event) {
    logger.warn('No event type found in Blockradar webhook.');
    return res.status(400).send('Event type missing.');
  }

  try {
    // Extract necessary fields based on Blockradar's webhook structure
    const data = parsedBody.data;

    // Example: Handle 'deposit.success' event
    if (event === 'deposit.success') {
      if (!data) {
        throw new Error('Missing data in Blockradar webhook.');
      }

      const walletAddress = data.recipientAddress || 'N/A';
      const amount = parseFloat(data.amount) || 0;
      const asset = data.asset?.symbol || 'N/A';
      const transactionHash = data.hash || 'N/A';
      const chainRaw = data.blockchain?.name || 'N/A';
      const senderAddress = data.senderAddress || 'N/A';

      // Normalize and map the chain name for ease
      const chainKey = chainMapping[chainRaw.toLowerCase()];
      if (!chainKey) {
        logger.error(`Unknown chain received in Blockradar webhook: ${chainRaw}`);
        // Notify admin about the unknown chain
        await bot.telegram.sendMessage(
          PERSONAL_CHAT_ID,
          `⚠️ Received deposit on unknown chain: \`${chainRaw}\``,
          { parse_mode: 'Markdown' }
        );
        return res.status(400).send('Unknown chain.');
      }

      const chain = chainKey;

      // **Duplicate Check Start**
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
        logger.warn(`No user found for wallet address ${walletAddress}`);
        // Notify admin about the unmatched wallet
        await bot.telegram.sendMessage(
          PERSONAL_CHAT_ID,
          `⚠️ No user found for wallet address: \`${walletAddress}\``,
          { parse_mode: 'Markdown' }
        );
        return res.status(200).send('OK');
      }

      const userDoc = usersSnapshot.docs[0];
      const userId = userDoc.id;
      const userState = userDoc.data();
      const wallet = userState.wallets.find((w) => w.address === walletAddress);

      // Check if Wallet has Linked Bank
      if (!wallet || !wallet.bank) {
        await bot.telegram.sendMessage(
          userId,
          `💰 *Deposit Received:* ${amount} ${asset} on ${chainRaw}.\n\nPlease link a bank account to receive your payout securely.`,
          { parse_mode: 'Markdown' }
        );
        await bot.telegram.sendMessage(
          PERSONAL_CHAT_ID,
          `⚠️ User ${userId} has received a deposit but hasn't linked a bank account.`,
          { parse_mode: 'Markdown' }
        );
        return res.status(200).send('OK');
      }

      // Only support USDC and USDT
      if (!['USDC', 'USDT'].includes(asset)) {
        await bot.telegram.sendMessage(
          userId,
          `⚠️ *Unsupported Asset Deposited:* ${asset}.\n\nCurrently, only *USDC* and *USDT* are supported. Please contact support if you believe this is an error.`,
          { parse_mode: 'Markdown' }
        );
        await bot.telegram.sendMessage(
          PERSONAL_CHAT_ID,
          `⚠️ User ${userId} deposited unsupported asset: ${asset}.`,
          { parse_mode: 'Markdown' }
        );
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

      // **Removed "Order Pending" Message to User**
      // Previously, the bot sent a pending message to the user. This has been removed as per the user's request.

      // Notify admin with detailed deposit information
      const adminDepositMessage = `⚡️ *New Deposit Received*\n\n` +
        `*User ID:* ${userId}\n` +
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
      await bot.telegram.sendMessage(
        PERSONAL_CHAT_ID,
        adminDepositMessage,
        { parse_mode: 'Markdown' }
      );

      // Integrate Paycrest to off-ramp automatically
      const paycrestMapping = mapToPaycrest(asset, chainRaw);
      if (!paycrestMapping) {
        logger.error('No Paycrest mapping for this asset/chain.');
        await bot.telegram.sendMessage(
          PERSONAL_CHAT_ID,
          `⚠️ No Paycrest mapping found for asset ${asset} on chain ${chainRaw}.`
        );
        return res.status(200).send('OK');
      }

      // Create Paycrest order with returnAddress as senderAddress
      let paycrestOrder;
      try {
        paycrestOrder = await createPaycrestOrder(
          userId,
          amount,
          asset,
          chainRaw,
          wallet.bank,
          senderAddress
        );
        await transactionRef.update({ paycrestOrderId: paycrestOrder.id });
      } catch (err) {
        logger.error(`Error creating Paycrest order for user ${userId}: ${err.message}`);
        // Notify admin about the failure
        await bot.telegram.sendMessage(
          PERSONAL_CHAT_ID,
          `❗️ Error creating Paycrest order for user ${userId}: ${err.message}`,
          { parse_mode: 'Markdown' }
        );
        // Update transaction status to 'Failed'
        await transactionRef.update({ status: 'Failed' });
        // Update user's pending message to indicate failure
        // **Removed Pending Message Update**
        // Previously, the bot updated a pending message to indicate failure. This has been removed.

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
        await withdrawFromBlockradar(
          chainRaw,
          blockradarAssetId,
          receiveAddress,
          amount,
          paycrestOrder.id,
          { userId, originalTxHash: transactionHash }
        );
      } catch (err) {
        logger.error(`Error withdrawing from Blockradar for user ${userId}: ${err.response ? err.response.data.message : err.message}`);
        // Notify admin about this failure
        await bot.telegram.sendMessage(
          PERSONAL_CHAT_ID,
          `❗️ Error withdrawing from Blockradar for user ${userId}: ${err.response ? err.response.data.message : err.message}`,
          { parse_mode: 'Markdown' }
        );
        // Update transaction status to 'Failed'
        await transactionRef.update({ status: 'Failed' });
        // Update user's pending message to indicate failure
        // **Removed Pending Message Update**
        // Previously, the bot updated a pending message to indicate failure. This has been removed.

        return res.status(500).send('Blockradar withdrawal error');
      }

      // Update transaction status to 'Pending'
      await db.collection('transactions').doc(transactionRef.id).update({ status: 'Pending' });

      logger.info(`Transaction stored for user ${userId}: Reference ID ${paycrestOrder.id}`);

      res.status(200).send('OK');
    } else {
      logger.warn(`Unhandled Blockradar webhook event type: ${event}`);
      res.status(200).send('Unhandled event type.');
    }
  } catch (error) {
    logger.error(`Error processing Blockradar webhook: ${error.message}`);
    await bot.telegram.sendMessage(
      PERSONAL_CHAT_ID,
      `❗️ Error processing Blockradar webhook: ${error.message}`,
      { parse_mode: 'Markdown' }
    );
    res.status(500).send('Error processing webhook');
  }
});

// =================== Paycrest Webhook Handler ===================

/**
 * =================== Paycrest Webhook Handler ===================
 */
app.post('/webhook/paycrest', express.raw({ type: 'application/json' }), async (req, res) => {
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
    // Handle different Paycrest events
    switch (event) {
      case 'payment_order.pending':
        await handlePaymentOrderPending(data);
        break;

      case 'payment_order.settled':
        await handlePaymentOrderSettled(data);
        break;

      case 'payment_order.expired':
        await handlePaymentOrderExpired(data);
        break;

      case 'payment_order.refunded':
        await handlePaymentOrderRefunded(data);
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
 * Handles 'payment_order.pending' event.
 * @param {object} data - Event data.
 */
async function handlePaymentOrderPending(data) {
  const orderId = data.id;
  const status = data.status;
  const amountPaid = parseFloat(data.amountPaid) || 0;
  const reference = data.reference;
  const returnAddress = data.returnAddress;

  // Fetch the transaction by Paycrest order ID
  const txSnapshot = await db.collection('transactions').where('paycrestOrderId', '==', orderId).limit(1).get();

  if (txSnapshot.empty) {
    logger.error(`No transaction found for Paycrest orderId: ${orderId}`);
    await bot.telegram.sendMessage(
      PERSONAL_CHAT_ID,
      `❗️ No transaction found for Paycrest orderId: \`${orderId}\``,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  const txDoc = txSnapshot.docs[0];
  const txData = txDoc.data();
  const userId = txData.userId;
  const userFirstName = txData.firstName || 'Valued User';

  // **Removed "Order Pending" Message to User**
  // Previously, the bot sent a pending message to the user. This has been removed as per the user's request.

  // Log to admin
  await bot.telegram.sendMessage(
    PERSONAL_CHAT_ID,
    `🔄 *Payment Order Pending*\n\n` +
    `*User:* ${userFirstName} (ID: ${userId})\n` +
    `*Reference ID:* ${reference}\n` +
    `*Amount Paid:* ₦${amountPaid}\n`,
    { parse_mode: 'Markdown' }
  );
}

/**
 * Handles 'payment_order.settled' event.
 * @param {object} data - Event data.
 */
async function handlePaymentOrderSettled(data) {
  const orderId = data.id;
  const status = data.status;
  const amountPaid = parseFloat(data.amountPaid) || 0;
  const reference = data.reference;
  const txHash = data.txHash || 'N/A'; // Assuming 'txHash' is provided for settlement

  // Fetch the transaction by Paycrest order ID
  const txSnapshot = await db.collection('transactions').where('paycrestOrderId', '==', orderId).limit(1).get();

  if (txSnapshot.empty) {
    logger.error(`No transaction found for Paycrest orderId: ${orderId}`);
    await bot.telegram.sendMessage(
      PERSONAL_CHAT_ID,
      `❗️ No transaction found for Paycrest orderId: \`${orderId}\``,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  const txDoc = txSnapshot.docs[0];
  const txData = txDoc.data();
  const userId = txData.userId;
  const userFirstName = txData.firstName || 'Valued User';

  // Send settled message to user
  await bot.telegram.sendMessage(
    userId,
    `🎉 *Funds Credited Successfully!*\n\n` +
    `Hello ${userFirstName},\n\n` +
    `Your DirectPay order has been completed. Here are the details of your order:\n\n` +
    `*Crypto Amount:* ${txData.amount} ${txData.asset}\n` +
    `*Cash Amount:* NGN ${amountPaid}\n` +
    `*Network:* ${txData.chain}\n` +
    `*Transaction Hash:* \`${txHash}\`\n` +
    `*Date:* ${txData.timestamp ? new Date(txData.timestamp).toLocaleString() : 'N/A'}\n\n` + 
    `Thank you 💙.`,
    { parse_mode: 'Markdown' }
  );

  // Update transaction status in Firestore
  await db.collection('transactions').doc(txDoc.id).update({ status: 'Completed' });

  // Log to admin
  await bot.telegram.sendMessage(
    PERSONAL_CHAT_ID,
    `✅ *Payment Order Settled*\n\n` +
    `*User:* ${userFirstName} (ID: ${userId})\n` +
    `*Reference ID:* ${reference}\n` +
    `*Amount Paid:* ₦${amountPaid}\n` +
    `*Transaction Hash:* \`${txHash}\`\n`,
    { parse_mode: 'Markdown' }
  );

  // Prompt user to rate the service
  await bot.telegram.sendMessage(
    userId,
    `⭐️ *Rate Our Service*\n\n` +
    `We hope you had a great experience! Please rate our service below:`,
    Markup.inlineKeyboard([
      [Markup.button.callback('⭐️', 'rate_1')],
      [Markup.button.callback('⭐️⭐️', 'rate_2')],
      [Markup.button.callback('⭐️⭐️⭐️', 'rate_3')],
      [Markup.button.callback('⭐️⭐️⭐️⭐️', 'rate_4')],
      [Markup.button.callback('⭐️⭐️⭐️⭐️⭐️', 'rate_5')],
    ])
  );

  // Log username to admin
  await bot.telegram.sendMessage(
    PERSONAL_CHAT_ID,
    `👤 *User Information*\n\n` +
    `*User ID:* ${userId}\n` +
    `*Username:* @${txData.username || 'N/A'}\n` +
    `*First Name:* ${userFirstName}\n`,
    { parse_mode: 'Markdown' }
  );
}

/**
 * Handles 'payment_order.expired' event.
 * @param {object} data - Event data.
 */
async function handlePaymentOrderExpired(data) {
  const orderId = data.id;
  const status = data.status;
  const refundTxHash = data.refundTxHash || 'N/A'; // Assuming 'refundTxHash' is provided
  const reference = data.reference;

  // Fetch the transaction by Paycrest order ID
  const txSnapshot = await db.collection('transactions').where('paycrestOrderId', '==', orderId).limit(1).get();

  if (txSnapshot.empty) {
    logger.error(`No transaction found for Paycrest orderId: ${orderId}`);
    await bot.telegram.sendMessage(
      PERSONAL_CHAT_ID,
      `❗️ No transaction found for Paycrest orderId: \`${orderId}\``,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  const txDoc = txSnapshot.docs[0];
  const txData = txDoc.data();
  const userId = txData.userId;
  const userFirstName = txData.firstName || 'Valued User';

  // Send expired message to user
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
    `*Reference ID:* ${reference}\n` +
    `*Refund Transaction Hash:* \`${refundTxHash}\`\n`,
    { parse_mode: 'Markdown' }
  );
}

/**
 * Handles 'payment_order.refunded' event.
 * @param {object} data - Event data.
 */
async function handlePaymentOrderRefunded(data) {
  const orderId = data.id;
  const status = data.status;
  const refundTxHash = data.txHash || 'N/A'; // Assuming 'refundTxHash' is provided
  const reference = data.reference;

  // Fetch the transaction by Paycrest order ID
  const txSnapshot = await db.collection('transactions').where('paycrestOrderId', '==', orderId).limit(1).get();

  if (txSnapshot.empty) {
    logger.error(`No transaction found for Paycrest orderId: ${orderId}`);
    await bot.telegram.sendMessage(
      PERSONAL_CHAT_ID,
      `❗️ No transaction found for Paycrest orderId: \`${orderId}\``,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  const txDoc = txSnapshot.docs[0];
  const txData = txDoc.data();
  const userId = txData.userId;
  const userFirstName = txData.firstName || 'Valued User';

  // Send refunded message to user
  await bot.telegram.sendMessage(
    userId,
    `❌ *Your DirectPay order has been refunded.*\n\n` +
    `Hello ${userFirstName},\n\n` +
    `We regret to inform you that your DirectPay order with *Reference ID:* \`${reference}\` has been refunded.\n\n` +
    `*Reason:* We experienced issues while processing your order. Rest assured, the funds have been returned to your original payment method.\n\n` +
    `*Refund Transaction Hash:* \`${refundTxHash}\`\n\n` +
    `If you believe this is a mistake or need further assistance, please don't hesitate to contact our support team.\n\n` +
    `Thank you for your understanding.`,
    { parse_mode: 'Markdown' }
  );

  // Update transaction status in Firestore
  await db.collection('transactions').doc(txDoc.id).update({ status: 'Refunded' });

  // Log to admin
  await bot.telegram.sendMessage(
    PERSONAL_CHAT_ID,
    `🔄 *Payment Order Refunded*\n\n` +
    `*User:* ${userFirstName} (ID: ${userId})\n` +
    `*Reference ID:* ${reference}\n` +
    `*Refund Transaction Hash:* \`${refundTxHash}\`\n`,
    { parse_mode: 'Markdown' }
  );
}

// =================== Shutdown Handlers ===================
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

// =================== Start Express Server ===================
app.listen(PORT, () => {
  logger.info(`Express server listening on port ${PORT}`);
});
