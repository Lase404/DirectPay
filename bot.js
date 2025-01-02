// =================== Import Required Libraries ===================
const { Telegraf, Scenes, session, Markup } = require('telegraf');
const express = require('express');
const bodyParser = require('body-parser');
const admin = require('firebase-admin');
const axios = require('axios');
const crypto = require('crypto');
const winston = require('winston');
const fs = require('fs');
const path = require('path');

// =================== Initialize Logging ===================
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(
      ({ timestamp, level, message }) => `[${timestamp}] ${level.toUpperCase()}: ${message}`
    )
  ),
  transports: [
    new winston.transports.Console(),
    // Optionally, add file transports
    // new winston.transports.File({ filename: 'combined.log' }),
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
  BOT_TOKEN, // Telegram Bot Token
  PAYCREST_API_KEY,
  PAYCREST_CLIENT_SECRET,
  PAYCREST_RATE_API_URL = 'https://api.paycrest.io/v1/rates',
  PAYCREST_RETURN_ADDRESS = "0xYourReturnAddressHere", // Replace with actual return address
  PERSONAL_CHAT_ID, // Admin's Telegram Chat ID
  PAYSTACK_API_KEY,
  ADMIN_IDS = '', // Comma-separated list of admin User IDs
  WEBHOOK_PATH = '/webhook/telegram',
  WEBHOOK_DOMAIN, // e.g., 'https://yourdomain.com'
  PORT = 4000,
  BLOCKRADAR_BASE_API_KEY,
  BLOCKRADAR_BNB_API_KEY,
  BLOCKRADAR_POLYGON_API_KEY,
  MAX_WALLETS = 5, // Maximum number of wallets per user
} = process.env;

// =================== Initialize Express and Telegraf ===================
const app = express();

// Initialize Telegraf bot with BOT_TOKEN
const bot = new Telegraf(BOT_TOKEN);

// =================== Define Supported Banks ===================
const bankList = [
  // Example:
  {
    name: 'GTBank',
    code: '058',
    logo: 'https://example.com/gtbank-logo.png'
  },
  // Add other banks as needed
];

// =================== Define Supported Chains ===================
const chains = {
  base: {
    name: 'Base',
    assets: {
      USDC: 'usdc-asset-id-base',
      USDT: 'usdt-asset-id-base'
    },
    supportedAssets: ['USDC', 'USDT']
  },
  polygon: {
    name: 'Polygon',
    assets: {
      USDC: 'usdc-asset-id-polygon',
      USDT: 'usdt-asset-id-polygon'
    },
    supportedAssets: ['USDC', 'USDT']
  },
  'bnb-smart-chain': {
    name: 'BNB Smart Chain',
    assets: {
      USDC: 'usdc-asset-id-bsc',
      USDT: 'usdt-asset-id-bsc'
    },
    supportedAssets: ['USDC', 'USDT']
  },
  // Add other chains as needed
};

// =================== Chain Mapping ===================
const chainMapping = {
  base: 'Base',
  polygon: 'Polygon',
  'bnb smart chain': 'BNB Smart Chain',
  'bnb-smart-chain': 'BNB Smart Chain',
  // Add other mappings as needed
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
    const response = await axios.get(`https://api.paystack.co/bank/resolve?account_number=${accountNumber}&bank_code=${bankCode}`, {
      headers: {
        Authorization: `Bearer ${PAYSTACK_API_KEY}`
      }
    });

    if (response.data.status) {
      return response.data.data;
    } else {
      throw new Error(response.data.message || 'Bank account verification failed.');
    }
  } catch (error) {
    logger.error(`Error verifying bank account: ${error.message}`);
    throw error;
  }
}

/**
 * Creates a Paycrest order for off-ramping.
 * @param {string} userId - Telegram user ID.
 * @param {number} amount - Amount of asset.
 * @param {string} token - Asset token (e.g., 'USDC', 'USDT').
 * @param {string} network - Blockchain network.
 * @param {object} recipientDetails - Bank details of the recipient.
 * @param {string} refundAddress - Address to refund in case of failure.
 * @returns {object} - Paycrest order data.
 */
async function createPaycrestOrder(userId, amount, token, network, recipientDetails, userSendAddress) {
  try {
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

    // payload
    const orderPayload = {
      amount: String(amount), // Token amount as string
      rate: String(rate), // Exchange rate as string from Paycrest Rate API
      network: paycrestMapping.network, // e.g., 'polygon', 'base', etc.
      token: paycrestMapping.token, // 'USDT' or 'USDC'
      recipient: recipient,
      returnAddress: senderAddress || PAYCREST_RETURN_ADDRESS, // Use user's send address or default
      feePercent: 2, // Example fee percentage
    };

    // API req
    const orderResp = await axios.post('https://api.paycrest.io/v1/sender/orders', orderPayload, {
      headers: {
        'API-Key': PAYCREST_API_KEY,
        'Content-Type': 'application/json'
      }
    });

    // response OK?
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
    const apiKeyMap = {
      base: BLOCKRADAR_BASE_API_KEY,
      polygon: BLOCKRADAR_POLYGON_API_KEY,
      'bnb-smart-chain': BLOCKRADAR_BNB_API_KEY,
      // Add other chains and their API keys as needed
    };

    const apiKey = apiKeyMap[chain.toLowerCase()];
    if (!apiKey) {
      throw new Error(`No API key configured for chain: ${chain}`);
    }

    const payload = {
      assetId,
      address,
      amount,
      reference,
      metadata
    };

    const response = await axios.post(`https://api.blockradar.io/v1/withdrawals`, payload, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      }
    });

    if (response.data.status === 'success') {
      return response.data.data; // Assuming Blockradar returns withdrawal data in 'data'
    } else {
      throw new Error(response.data.message || 'Failed to withdraw from Blockradar.');
    }
  } catch (error) {
    logger.error(`Error withdrawing from Blockradar: ${error.message}`);
    throw error;
  }
}

/**
 * Retrieves the user's state from Firestore.
 * @param {string} userId - Telegram user ID.
 * @returns {object} - User state.
 */
async function getUserState(userId) {
  const userDoc = await db.collection('users').doc(userId).get();
  if (!userDoc.exists) {
    throw new Error(`User with ID ${userId} does not exist.`);
  }
  return userDoc.data();
}

/**
 * Updates the user's state in Firestore.
 * @param {string} userId - Telegram user ID.
 * @param {object} newState - New state to update.
 */
async function updateUserState(userId, newState) {
  await db.collection('users').doc(userId).update(newState);
}

/**
 * Generates a transaction receipt message.
 * @param {object} txData - Transaction data.
 * @returns {string} - Receipt message.
 */
function generateReceipt(txData) {
  return `📄 **Transaction Receipt**

**Reference ID:** ${txData.referenceId || 'N/A'}
**User ID:** ${txData.userId || 'N/A'}
**Amount Deposited:** ${txData.amount || 'N/A'} ${txData.asset || 'N/A'}
**Amount Paid:** ₦${txData.payout || 'N/A'}
**Status:** ${txData.status || 'Pending'}
**Chain:** ${txData.chain || 'N/A'}
**Transaction Hash:** ${txData.transactionHash || 'N/A'}
**Date:** ${txData.timestamp ? new Date(txData.timestamp).toLocaleString() : 'N/A'}

Thank you for using **DirectPay**!`;
}

// =================== Define Scenes ===================

/**
 * =================== Bank Linking Scene ===================
 */
const bankLinkingScene = new Scenes.WizardScene(
  'bank_linking_scene',
  async (ctx) => {
    ctx.replyWithMarkdown('🏦 *Enter Your Bank Code:*');
    return ctx.wizard.next();
  },
  async (ctx) => {
    const bankCode = ctx.message.text.trim();
    // Validate bank code exists in bankList
    const bank = bankList.find(b => b.code === bankCode);
    if (!bank) {
      await ctx.replyWithMarkdown('❌ Invalid bank code. Please enter a valid bank code from the list.');
      return;
    }
    ctx.wizard.state.bank = bank;
    ctx.replyWithMarkdown('💳 *Enter Your Bank Account Number:*');
    return ctx.wizard.next();
  },
  async (ctx) => {
    const accountNumber = ctx.message.text.trim();
    // Basic validation for account number length
    if (accountNumber.length < 10 || accountNumber.length > 10) { // Example: 10-digit account numbers
      await ctx.replyWithMarkdown('❌ Invalid account number format. Please enter a 10-digit account number.');
      return;
    }
    ctx.wizard.state.accountNumber = accountNumber;
    // Verify bank account details using Paystack
    try {
      const verification = await verifyBankAccount(accountNumber, ctx.wizard.state.bank.code);
      ctx.wizard.state.accountName = verification.account_name;
      ctx.replyWithMarkdown(`✅ *Account Verified:*\n\n**Account Name:** ${verification.account_name}\n**Bank:** ${ctx.wizard.state.bank.name}`);
      return ctx.wizard.next();
    } catch (error) {
      logger.error(`Bank account verification failed: ${error.message}`);
      await ctx.replyWithMarkdown(`❌ Bank account verification failed: ${error.message}`);
      return ctx.scene.leave();
    }
  },
  async (ctx) => {
    const userId = ctx.from.id.toString();
    try {
      const userState = await getUserState(userId);
      const walletIndex = ctx.session.walletIndex || 0; // Assuming walletIndex is set in session
      
      if (!userState.wallets[walletIndex]) {
        await ctx.replyWithMarkdown('❌ Invalid wallet selection.');
        return ctx.scene.leave();
      }
      
      // Update the bank details for the selected wallet
      userState.wallets[walletIndex].bank = {
        bankName: ctx.wizard.state.bank.name,
        bankCode: ctx.wizard.state.bank.code,
        accountNumber: ctx.wizard.state.accountNumber,
        accountName: ctx.wizard.state.accountName
      };
      
      await updateUserState(userId, { wallets: userState.wallets });
      
      await ctx.replyWithMarkdown('✅ Your bank account has been linked successfully.');
      
      // Optionally, notify admin about the bank linking
      await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `🔗 *Bank Linked*\n\nUser ID: ${userId}\nBank: ${ctx.wizard.state.bank.name}\nAccount Number: ****${ctx.wizard.state.accountNumber.slice(-4)}`, { parse_mode: 'Markdown' });
      
      return ctx.scene.leave();
    } catch (error) {
      logger.error(`Error linking bank account for user ${userId}: ${error.message}`);
      await ctx.replyWithMarkdown('❌ An error occurred while linking your bank account. Please try again later.');
      return ctx.scene.leave();
    }
  }
);

/**
 * =================== Send Message Scene ===================
 */
const sendMessageScene = new Scenes.WizardScene(
  'send_message_scene',
  async (ctx) => {
    ctx.replyWithMarkdown('📝 *Enter the message you want to broadcast to all users:*');
    return ctx.wizard.next();
  },
  async (ctx) => {
    const message = ctx.message.text.trim();
    if (!message) {
      await ctx.replyWithMarkdown('❌ Message cannot be empty. Please enter a valid message.');
      return;
    }
    ctx.wizard.state.message = message;
    ctx.replyWithMarkdown('📤 *Sending broadcast message...*');
    return ctx.wizard.next();
  },
  async (ctx) => {
    const message = ctx.wizard.state.message;
    try {
      const usersSnapshot = await db.collection('users').get();
      if (usersSnapshot.empty) {
        await ctx.replyWithMarkdown('⚠️ No users found to send messages.');
        return ctx.scene.leave();
      }
      
      const sendPromises = [];
      
      usersSnapshot.forEach((doc) => {
        const userId = doc.id;
        sendPromises.push(bot.telegram.sendMessage(userId, `📢 *Broadcast Message:*\n\n${message}`, { parse_mode: 'Markdown' }));
      });
      
      await Promise.all(sendPromises);
      
      await ctx.replyWithMarkdown('✅ Broadcast message sent to all users.');
      logger.info(`Admin ${userId} sent a broadcast message: "${message}" to ${usersSnapshot.size} users.`);
      
      return ctx.scene.leave();
    } catch (error) {
      logger.error(`Error sending broadcast message: ${error.message}`);
      await ctx.replyWithMarkdown('❌ An error occurred while sending the broadcast message. Please try again later.');
      return ctx.scene.leave();
    }
  }
);

/**
 * =================== Receipt Generation Scene ===================
 */
const receiptGenerationScene = new Scenes.WizardScene(
  'receipt_generation_scene',
  async (ctx) => {
    const userId = ctx.from.id.toString();
    try {
      const userState = await getUserState(userId);
      const walletIndex = ctx.session.walletIndex;
      
      if (walletIndex === undefined || !userState.wallets[walletIndex]) {
        await ctx.replyWithMarkdown('❌ Invalid wallet selection.');
        return ctx.scene.leave();
      }
      
      ctx.wizard.state.walletIndex = walletIndex;
      ctx.replyWithMarkdown('🔍 *Fetching transactions...*');
      return ctx.wizard.next();
    } catch (error) {
      logger.error(`Error fetching user state for receipt generation: ${error.message}`);
      await ctx.replyWithMarkdown('❌ An error occurred while fetching your transactions.');
      return ctx.scene.leave();
    }
  },
  async (ctx) => {
    const userId = ctx.from.id.toString();
    const walletIndex = ctx.wizard.state.walletIndex;
    
    try {
      const userState = await getUserState(userId);
      const transactions = userState.wallets[walletIndex].transactions || [];
      
      if (transactions.length === 0) {
        await ctx.replyWithMarkdown('❌ No transactions found for this wallet.');
        return ctx.scene.leave();
      }
      
      // Generate receipt
      const lastTransaction = transactions[transactions.length - 1]; // Example: Last transaction
      const receipt = generateReceipt(lastTransaction);
      
      await ctx.replyWithMarkdown(receipt);
      return ctx.scene.leave();
    } catch (error) {
      logger.error(`Error generating receipt for user ${userId}: ${error.message}`);
      await ctx.replyWithMarkdown('❌ An error occurred while generating the receipt.');
      return ctx.scene.leave();
    }
  }
);

// =================== Register Scenes with Stage ===================
const stage = new Scenes.Stage();
stage.register(bankLinkingScene, sendMessageScene, receiptGenerationScene);

// **IMPORTANT: Apply Session and Stage Middleware Before Defining Routes**
bot.use(session()); // Initialize session middleware
bot.use(stage.middleware()); // Apply stage middleware

// =================== Webhook Handlers ===================

// ------------------ Paycrest Webhook ------------------
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

// =================== Paycrest Webhook Handler ===================
app.post('/webhook/paycrest', bodyParser.raw({ type: 'application/json' }), async (req, res) => {
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

  if (!event || !data) {
    logger.error('Missing event or data in Paycrest webhook.');
    return res.status(400).send('Invalid webhook payload.');
  }

  const eventType = event.type;

  // Log the received event for debugging purposes
  logger.info(`Received Paycrest event: ${eventType}`);

  // Handle different event types
  if (eventType === 'payment_order.settled') {
    await handlePaymentOrderSettled(data, res);
  } else if (eventType === 'payment_order.pending') {
    await handlePaymentOrderPending(data, res);
  } else if (eventType === 'payment_order.refunded') {
    await handlePaymentOrderRefunded(data, res);
  } else {
    logger.warn(`Unhandled Paycrest webhook event type: ${eventType}`);
    res.status(200).send('OK'); // Respond OK even if not handled to prevent retries
  }
});

// ------------------ Blockradar Webhook ------------------
/**
 * Handles Blockradar webhooks.
 * Applies bodyParser.raw() specifically to this route.
 */
app.post('/webhook/blockradar', bodyParser.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const event = JSON.parse(req.body.toString());
    logger.info(`Received Blockradar webhook: ${JSON.stringify(event)}`);
    fs.appendFileSync(path.join(__dirname, 'webhook_logs.txt'), `${new Date().toISOString()} - ${JSON.stringify(event, null, 2)}\n`);

    // Extract common event data
    const eventType = event.event || 'Unknown Event';
    const recipientAddress = event.data?.recipientAddress || 'N/A'; // Updated to use recipientAddress
    const senderAddress = event.data?.senderAddress || 'N/A';
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
      await handleBlockradarDepositSuccess(event, res);
    } else {
      logger.warn(`Unhandled Blockradar webhook event type: ${eventType}`);
      res.status(200).send('OK'); // Respond OK even if not handled to prevent retries
    }
  } catch (error) {
    logger.error(`Error processing Blockradar webhook: ${error.message}`);
    res.status(500).send('Error');
    // Notify admin about the error
    await bot.telegram.sendMessage(
      PERSONAL_CHAT_ID,
      `❗️ Error processing Blockradar webhook: ${error.message}`,
      { parse_mode: 'Markdown' }
    );
  }
});

/**
 * Handles 'deposit.success' event from Blockradar.
 * @param {object} event - Blockradar event data.
 * @param {object} res - Express response object.
 */
async function handleBlockradarDepositSuccess(event, res) {
  const recipientAddress = event.data?.recipientAddress || 'N/A'; // Updated to use recipientAddress
  const senderAddress = event.data?.senderAddress || 'N/A'; // For refund
  const amount = parseFloat(event.data?.amount) || 0;
  const asset = event.data?.asset?.symbol || 'N/A';
  const transactionHash = event.data?.hash || 'N/A';
  const chainRaw = event.data?.blockchain?.name || 'N/A';

  try {
    // **Duplicate Check Start**
    // Check if a transaction with the same hash already exists
    const existingTxSnapshot = await db.collection('transactions').where('transactionHash', '==', transactionHash).get();
    if (!existingTxSnapshot.empty) {
      logger.info(`Transaction with hash ${transactionHash} already exists. Skipping.`);
      return res.status(200).send('OK');
    }
    // **Duplicate Check End**

    // Find user by recipientAddress
    const userSnapshot = await db.collection('users').where('walletAddresses', 'array-contains', recipientAddress).get();

    if (userSnapshot.empty) {
      logger.warn(`No user found for recipientAddress ${recipientAddress}`);
      // Notify admin about the unmatched wallet
      await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `⚠️ No user found for recipient address: \`${recipientAddress}\``);
      return res.status(200).send('OK');
    }

    const userDoc = userSnapshot.docs[0];
    const userId = userDoc.id;
    const userState = userDoc.data();

    // Find the specific wallet
    const wallet = userState.wallets.find((w) => w.address === recipientAddress);

    if (!wallet) {
      logger.warn(`User ${userId} does not have a wallet with address ${recipientAddress}`);
      await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `⚠️ User ${userId} does not have a wallet with address: \`${recipientAddress}\``);
      return res.status(200).send('OK');
    }

    // Check if Wallet has Linked Bank
    if (!wallet.bank) {
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

    // Create Transaction Document with Status 'Processing' and store messageId as null initially
    const transactionRef = await db.collection('transactions').add({
      userId,
      walletAddress: recipientAddress,
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
      `*Exchange Rate:* ₦${rate} per ${asset}\n` + // Added exchange rate
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
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, adminDepositMessage, { parse_mode: 'Markdown' });

    // Integrate Paycrest to off-ramp automatically
    const paycrestMapping = mapToPaycrest(asset, chainRaw);
    if (!paycrestMapping) {
      logger.error('No Paycrest mapping for this asset/chain.');
      await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `⚠️ No Paycrest mapping found for asset ${asset} on chain ${chainRaw}.`);
      return res.status(200).send('OK');
    }

    // Use senderAddress as the refund address for Paycrest
    const refundAddress = senderAddress;

    // Create Paycrest order
    let paycrestOrder;
    try {
      paycrestOrder = await createPaycrestOrder(userId, amount, asset, chainRaw, wallet.bank, refundAddress); // Pass token amount and refund address
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
    const chainKeyLower = chainRaw.toLowerCase();
    switch (asset) {
      case 'USDC':
        blockradarAssetId = chains[chainKeyLower]?.assets['USDC'];
        break;
      case 'USDT':
        blockradarAssetId = chains[chainKeyLower]?.assets['USDT'];
        break;
      default:
        throw new Error(`Unsupported asset: ${asset}`);
    }

    if (!blockradarAssetId) {
      throw new Error(`No Blockradar asset ID found for asset ${asset} on chain ${chainRaw}`);
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

    // Store Transaction in Firestore
    await db.collection('transactions').doc(transactionRef.id).update({
      status: 'Pending',
      paycrestOrderId: paycrestOrder.id
    });

    logger.info(`Transaction stored for user ${userId}: Reference ID ${paycrestOrder.id}`);

    // Update User's Pending Message to Final Success Message
    const finalMessage = `🎉 *Funds Credited Successfully!*\n\n` +
      `Hello ${userFirstName},\n\n` +
      `Your DirectPay order has been completed. Here are the details of your order:\n\n` +
      `*Crypto amount:* ${amount} ${asset}\n` +
      `*Cash amount:* NGN ${ngnAmount}\n` +
      `*Exchange Rate:* ₦${exchangeRates[asset] || 'N/A'} per ${asset}\n` + // Added exchange rate
      `*Network:* ${chainRaw}\n` +
      `*Date:* ${new Date().toISOString()}\n\n` +
      `Thank you for using *DirectPay*! Your funds have been securely transferred to your bank account.`;

    try {
      await bot.telegram.editMessageText(userId, pendingMessage.message_id, null, finalMessage, { parse_mode: 'Markdown' });
      // Update transaction status to 'Completed'
      await db.collection('transactions').doc(transactionRef.id).update({ status: 'Completed' });
    } catch (error) {
      logger.error(`Error editing message for user ${userId}: ${error.message}`);
      // Optionally, notify admin about the failure to edit message
      await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ Failed to edit message for user ${userId}: ${error.message}`);
    }

    // Notify admin about the successful payment
    await bot.telegram.sendMessage(
      PERSONAL_CHAT_ID,
      `✅ *Payment Completed*\n\n` +
      `*User ID:* ${userId}\n` +
      `*Reference ID:* ${referenceId}\n` +
      `*Amount:* ${amount} ${asset}\n` +
      `*Bank:* ${wallet.bank.bankName}\n` +
      `*Account Number:* ****${wallet.bank.accountNumber.slice(-4)}\n` +
      `*Date:* ${new Date(timestamp).toLocaleString()}\n`,
      { parse_mode: 'Markdown' }
    );

    res.status(200).send('OK');
  } catch (error) {
    logger.error(`Error handling Blockradar deposit.success event: ${error.message}`);
    res.status(500).send('Error');
    // Notify admin about the error
    await bot.telegram.sendMessage(
      PERSONAL_CHAT_ID,
      `❗️ Error processing Blockradar deposit.success event: ${error.message}`,
      { parse_mode: 'Markdown' }
    );
  }
}

// =================== Paycrest Webhook Event Handlers ===================

/**
 * Handles the 'payment_order.settled' event from Paycrest.
 * @param {object} data - Event data payload.
 * @param {object} res - Express response object.
 */
async function handlePaymentOrderSettled(data, res) {
  const orderId = data.id;
  const status = data.status;
  const amountPaid = parseFloat(data.amountPaid) || 0;
  const reference = data.reference;
  const returnAddress = data.returnAddress;

  try {
    // Fetch the transaction by Paycrest order ID
    const txSnapshot = await db.collection('transactions').where('paycrestOrderId', '==', orderId).get();

    if (txSnapshot.empty) {
      logger.error(`No transaction found for Paycrest orderId: ${orderId}`);
      // Notify admin about the unmatched order
      await bot.telegram.sendMessage(
        PERSONAL_CHAT_ID,
        `⚠️ No transaction found for Paycrest orderId: \`${orderId}\``,
        { parse_mode: 'Markdown' }
      );
      return res.status(200).send('OK');
    }

    const txDoc = txSnapshot.docs[0];
    const txData = txDoc.data();
    const userId = txData.userId;
    const userFirstName = txData.firstName || 'Valued User';
    const referenceId = txData.referenceId || 'N/A';
    const amount = txData.amount || 'N/A';
    const asset = txData.asset || 'N/A';
    const bankDetails = txData.bankDetails || {};
    const timestamp = txData.timestamp || new Date().toISOString();

    // Update transaction status to 'Settled'
    await db.collection('transactions').doc(txDoc.id).update({ status: 'Settled' });

    // Notify user about the settlement
    await bot.telegram.sendMessage(
      userId,
      `✅ *Your DirectPay order has been settled.*\n\n` +
      `Hello ${userFirstName},\n\n` +
      `Your order with *Reference ID:* \`${reference}\` has been successfully settled.\n\n` +
      `*Amount Paid:* ₦${amountPaid}\n` +
      `*Refund Address:* \`${returnAddress}\`\n\n` +
      `If you have any questions or need further assistance, feel free to reach out to our support team.\n\n` +
      `Thank you for using *DirectPay*!`,
      { parse_mode: 'Markdown' }
    );

    // Notify admin about the settlement
    await bot.telegram.sendMessage(
      PERSONAL_CHAT_ID,
      `🔔 *Payment Order Settled*\n\n` +
      `*User:* ${userFirstName} (ID: ${userId})\n` +
      `*Reference ID:* ${reference}\n` +
      `*Amount Paid:* ₦${amountPaid}\n` +
      `*Refund Address:* ${returnAddress}\n` +
      `*Order ID:* ${orderId}\n`,
      { parse_mode: 'Markdown' }
    );

    res.status(200).send('OK');
  } catch (error) {
    logger.error(`Error handling payment_order.settled: ${error.message}`);
    res.status(500).send('Error');
    // Notify admin about the error
    await bot.telegram.sendMessage(
      PERSONAL_CHAT_ID,
      `❗️ Error processing Paycrest webhook for orderId ${orderId}: ${error.message}`,
      { parse_mode: 'Markdown' }
    );
  }
}

/**
 * Handles the 'payment_order.pending' event from Paycrest.
 * @param {object} data - Event data payload.
 * @param {object} res - Express response object.
 */
async function handlePaymentOrderPending(data, res) {
  const orderId = data.id;
  const status = data.status;
  const amountPaid = parseFloat(data.amountPaid) || 0;
  const reference = data.reference;
  const returnAddress = data.returnAddress;

  try {
    // Fetch the transaction by Paycrest order ID
    const txSnapshot = await db.collection('transactions').where('paycrestOrderId', '==', orderId).get();

    if (txSnapshot.empty) {
      logger.error(`No transaction found for Paycrest orderId: ${orderId}`);
      // Notify admin about the unmatched order
      await bot.telegram.sendMessage(
        PERSONAL_CHAT_ID,
        `⚠️ No transaction found for Paycrest orderId: \`${orderId}\``,
        { parse_mode: 'Markdown' }
      );
      return res.status(200).send('OK');
    }

    const txDoc = txSnapshot.docs[0];
    const txData = txDoc.data();
    const userId = txData.userId;
    const userFirstName = txData.firstName || 'Valued User';
    const referenceId = txData.referenceId || 'N/A';
    const amount = txData.amount || 'N/A';
    const asset = txData.asset || 'N/A';
    const bankDetails = txData.bankDetails || {};
    const timestamp = txData.timestamp || new Date().toISOString();

    // Update transaction status to 'Pending'
    await db.collection('transactions').doc(txDoc.id).update({ status: 'Pending' });

    // Notify user about the pending status
    await bot.telegram.sendMessage(
      userId,
      `⏳ *Your DirectPay order is pending.*\n\n` +
      `Hello ${userFirstName},\n\n` +
      `Your order with *Reference ID:* \`${reference}\` is currently pending.\n\n` +
      `*Amount Paid:* ₦${amountPaid}\n` +
      `*Refund Address:* \`${returnAddress}\`\n\n` +
      `We are processing your transaction and will update you once it's complete.\n\n` +
      `Thank you for your patience and for using *DirectPay*!`,
      { parse_mode: 'Markdown' }
    );

    // Notify admin about the pending order
    await bot.telegram.sendMessage(
      PERSONAL_CHAT_ID,
      `⏰ *Payment Order Pending*\n\n` +
      `*User:* ${userFirstName} (ID: ${userId})\n` +
      `*Reference ID:* ${reference}\n` +
      `*Amount Paid:* ₦${amountPaid}\n` +
      `*Refund Address:* ${returnAddress}\n` +
      `*Order ID:* ${orderId}\n`,
      { parse_mode: 'Markdown' }
    );

    res.status(200).send('OK');
  } catch (error) {
    logger.error(`Error handling payment_order.pending: ${error.message}`);
    res.status(500).send('Error');
    // Notify admin about the error
    await bot.telegram.sendMessage(
      PERSONAL_CHAT_ID,
      `❗️ Error processing Paycrest webhook for orderId ${orderId}: ${error.message}`,
      { parse_mode: 'Markdown' }
    );
  }
}

/**
 * Handles the 'payment_order.refunded' event from Paycrest.
 * @param {object} data - Event data payload.
 * @param {object} res - Express response object.
 */
async function handlePaymentOrderRefunded(data, res) {
  const orderId = data.id;
  const status = data.status;
  const amountPaid = parseFloat(data.amountPaid) || 0;
  const reference = data.reference;
  const returnAddress = data.returnAddress;

  try {
    // Fetch the transaction by Paycrest order ID
    const txSnapshot = await db.collection('transactions').where('paycrestOrderId', '==', orderId).get();

    if (txSnapshot.empty) {
      logger.error(`No transaction found for Paycrest orderId: ${orderId}`);
      // Notify admin about the unmatched order
      await bot.telegram.sendMessage(
        PERSONAL_CHAT_ID,
        `⚠️ No transaction found for Paycrest orderId: \`${orderId}\``,
        { parse_mode: 'Markdown' }
      );
      return res.status(200).send('OK');
    }

    const txDoc = txSnapshot.docs[0];
    const txData = txDoc.data();
    const userId = txData.userId;
    const userFirstName = txData.firstName || 'Valued User';
    const referenceId = txData.referenceId || 'N/A';
    const amount = txData.amount || 'N/A';
    const asset = txData.asset || 'N/A';
    const bankDetails = txData.bankDetails || {};
    const timestamp = txData.timestamp || new Date().toISOString();

    // Check if transaction is already refunded
    if (txData.status === 'Refunded') {
      logger.info(`Transaction ${orderId} already refunded.`);
      return res.status(200).send('OK');
    }

    // Update transaction status to 'Refunded'
    await db.collection('transactions').doc(txDoc.id).update({ status: 'Refunded' });

    // Notify user about the refund
    await bot.telegram.sendMessage(
      userId,
      `❌ *Your DirectPay order has been refunded.*\n\n` +
      `Hello ${userFirstName},\n\n` +
      `We regret to inform you that your DirectPay order with *Reference ID:* \`${reference}\` has been refunded.\n\n` +
      `*Reason:* We experienced issues while processing your order. Rest assured, the funds have been returned to your original payment method.\n\n` +
      `If you believe this is a mistake or need further assistance, please don't hesitate to contact our support team.\n\n` +
      `Thank you for your understanding.`,
      { parse_mode: 'Markdown' }
    );

    // Optionally, edit the pending message if exists
    if (txData.messageId) {
      try {
        await bot.telegram.editMessageText(userId, txData.messageId, null, `❌ *Your DirectPay order has been refunded.*\n\n` +
          `Hello ${userFirstName},\n\n` +
          `We regret to inform you that your DirectPay order with *Reference ID:* \`${reference}\` has been refunded.\n\n` +
          `*Reason:* We experienced issues while processing your order. Rest assured, the funds have been returned to your original payment method.\n\n` +
          `If you believe this is a mistake or need further assistance, please don't hesitate to contact our support team.\n\n` +
          `Thank you for your understanding.`,
          { parse_mode: 'Markdown' }
        );
      } catch (error) {
        logger.error(`Error editing message for user ${userId}: ${error.message}`);
        // Notify admin about the failure to edit message
        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ Failed to edit message for user ${userId}: ${error.message}`);
      }
    }

    // Notify admin about the refunded order
    await bot.telegram.sendMessage(
      PERSONAL_CHAT_ID,
      `🔄 *Payment Order Refunded*\n\n` +
      `*User:* ${userFirstName} (ID: ${userId})\n` +
      `*Reference ID:* ${reference}\n` +
      `*Amount Paid:* ₦${amountPaid}\n`,
      { parse_mode: 'Markdown' }
    );

    res.status(200).send('OK');
  } catch (error) {
    logger.error(`Error handling payment_order.refunded: ${error.message}`);
    res.status(500).send('Error');
    // Notify admin about the error
    await bot.telegram.sendMessage(
      PERSONAL_CHAT_ID,
      `❗️ Error processing Paycrest webhook for refunded orderId ${orderId}: ${error.message}`,
      { parse_mode: 'Markdown' }
    );
  }
}

// =================== Blockradar Webhook Handler ===================

// Already handled above with handleBlockradarDepositSuccess

// =================== Telegraf Bot Handlers ===================

// =================== Admin Menu Handlers ===================

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

/**
 * Checks if the user is an admin.
 * @param {string} userId - Telegram user ID.
 * @returns {boolean} - Admin status.
 */
// Removed duplicate isAdmin function

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
 * Greets the user and presents the main menu or admin panel.
 * @param {TelegrafContext} ctx - Telegraf context.
 */
async function greetUser(ctx) {
  const userId = ctx.from.id.toString();
  let userState;
  try {
    userState = await getUserState(userId);
  } catch (error) {
    logger.error(`Error fetching user state for ${userId}: ${error.message}`);
    // Create a new user document if not exists
    await db.collection('users').doc(userId).set({
      firstName: ctx.from.first_name || 'Valued User',
      wallets: [],
      walletAddresses: []
    });
    userState = await getUserState(userId);
  }

  const walletExists = userState.wallets.length > 0;
  const hasBankLinked = userState.wallets.some(wallet => wallet.bank);
  const adminUser = isAdmin(userId);

  const greeting = walletExists
    ? `👋 Hello, ${userState.firstName}!\n\nWelcome back to **DirectPay**, your gateway to seamless crypto transactions.\n\n💡 **Quick Start Guide:**\n1. **Add Your Bank Account**\n2. **Access Your Dedicated Wallet Address**\n3. **Send Stablecoins and Receive Cash Instantly**\n\nWe offer competitive rates and real-time updates to keep you informed. Your funds are secure, and you'll have cash in your account promptly!\n\nLet's get started!`
    : `👋 Welcome, ${userState.firstName}!\n\nThank you for choosing **DirectPay**. Let's embark on your crypto journey together. Use the menu below to get started.`;

  if (adminUser) {
    try {
      const sentMessage = await ctx.replyWithMarkdown(greeting, Markup.inlineKeyboard([
        [Markup.button.callback('🔧 Admin Panel', 'open_admin_panel')],
      ]));
      ctx.session.adminMessageId = sentMessage.message_id; // Store message ID in session if needed
    } catch (error) {
      logger.error(`Error sending admin greeting to user ${userId}: ${error.message}`);
      await ctx.replyWithMarkdown('⚠️ An error occurred while sending the greeting. Please try again later.');
    }
  } else {
    await ctx.replyWithMarkdown(greeting, getMainMenu(walletExists, hasBankLinked));
  }
}

/**
 * Generates the Main Menu Keyboard.
 * @param {boolean} walletExists - Whether the user has wallets.
 * @param {boolean} hasBankLinked - Whether the user has a linked bank account.
 * @returns {Markup} - Keyboard Markup.
 */
const getMainMenu = (walletExists, hasBankLinked) =>
  Markup.keyboard([
    [walletExists ? '💼 View Wallet' : '💼 Generate Wallet', hasBankLinked ? '⚙️ Settings' : '🏦 Link Bank Account'],
    ['💰 Transactions', 'ℹ️ Support', '📘 Learn About Base'],
    ['📈 View Current Rates'], // Added Refresh Rates Button
  ]).resize();

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
    logger.error(`Error navigating wallet pages for user ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred while navigating wallets. Please try again later.');
    ctx.answerCbQuery();
  }
});

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

/**
 * Checks if the user is an admin.
 * @param {string} userId - Telegram user ID.
 * @returns {boolean} - Admin status.
 */
// Removed duplicate isAdmin function

// =================== Handle Settings Menu Actions ===================
bot.action(/settings_(.+)/, async (ctx) => {
  const userId = ctx.from.id.toString();

  if (!isAdmin(userId)) {
    // Assuming only admins can access settings
    await ctx.reply('⚠️ Unauthorized access.');
    return ctx.answerCbQuery();
  }

  const action = ctx.match[1];

  switch (action) {
    case 'generate_wallet':
      // Handle Generate New Wallet from Settings
      await ctx.replyWithMarkdown('💼 *Generate New Wallet*\n\n' +
        'Select the network for which you want to generate a new wallet:',
        Markup.inlineKeyboard([
          [Markup.button.callback('Base', 'generate_wallet_Base')],
          [Markup.button.callback('Polygon', 'generate_wallet_Polygon')],
          [Markup.button.callback('BNB Smart Chain', 'generate_wallet_BNB Smart Chain')],
        ])
      );
      break;

    case 'edit_bank':
      // Handle Edit Linked Bank Details from Settings
      try {
        const userState = await getUserState(userId);

        if (userState.wallets.length === 0) {
          return ctx.replyWithMarkdown('❌ You have no wallets. Please generate a wallet first using the "💼 Generate Wallet" option.');
        }

        // If only one wallet, proceed to edit bank
        if (userState.wallets.length === 1) {
          ctx.session.walletIndex = 0;
          await ctx.scene.enter('bank_linking_scene');
        } else {
          // Multiple wallets, prompt user to select which wallet to edit
          let keyboard = userState.wallets.map((wallet, index) => [
            Markup.button.callback(`Wallet ${index + 1} - ${wallet.chain}`, `select_wallet_edit_bank_${index}`)
          ]);
          await ctx.reply('Please select the wallet for which you want to edit the bank details:', Markup.inlineKeyboard(keyboard));
        }
      } catch (error) {
        logger.error(`Error handling Edit Linked Bank Details in Settings for user ${userId}: ${error.message}`);
        await ctx.replyWithMarkdown('⚠️ An error occurred while editing your bank details. Please try again later.');
      }
      break;

    case 'support':
      // Handle Support from Settings
      await ctx.replyWithMarkdown('🛠️ *Support Section*\n\nSelect an option below:', Markup.inlineKeyboard([
        [Markup.button.callback('❓ How It Works', 'support_how_it_works')],
        [Markup.button.callback('⚠️ Transaction Not Received', 'support_not_received')],
        [Markup.button.callback('💬 Contact Support', 'support_contact')],
      ]));
      break;

    case 'generate_receipt':
      // Handle Generate Transaction Receipt from Settings
      try {
        const userState = await getUserState(userId);

        if (userState.wallets.length === 0) {
          return ctx.replyWithMarkdown('❌ You have no wallets. Please generate a wallet first using the "💼 Generate Wallet" option.');
        }

        // Prompt user to select which wallet to generate receipt for
        let keyboard = userState.wallets.map((wallet, index) => [
          Markup.button.callback(`Wallet ${index + 1} - ${wallet.chain}`, `select_receipt_wallet_${index}`)
        ]);
        await ctx.reply('Please select the wallet for which you want to generate a transaction receipt:', Markup.inlineKeyboard(keyboard));
      } catch (error) {
        logger.error(`Error handling Generate Transaction Receipt in Settings for user ${userId}: ${error.message}`);
        await ctx.replyWithMarkdown('⚠️ An error occurred while generating the receipt. Please try again later.');
      }
      break;

    case 'back_to_main':
      // Return to the main menu
      await greetUser(ctx);
      break;

    default:
      await ctx.answerCbQuery('⚠️ Unknown settings option selected.');
  }

  // Acknowledge the callback to remove the loading state
  await ctx.answerCbQuery();
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

// Handle Wallet Selection for Generating Receipt
bot.action(/select_receipt_wallet_(\d+)/, async (ctx) => {
  const userId = ctx.from.id.toString();
  const walletIndex = parseInt(ctx.match[1], 10);

  if (isNaN(walletIndex)) {
    await ctx.replyWithMarkdown('⚠️ Invalid wallet selection. Please try again.');
    return ctx.answerCbQuery();
  }

  ctx.session.walletIndex = walletIndex;
  await ctx.scene.enter('receipt_generation_scene');
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
   - If the issue persists after following the above steps, reach out to our support team at [@maxcswap](https://t.me/maxcswap) with your transaction details for further assistance.
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

// =================== Learn About Base Handler ===================
// Already handled above

// =================== Transactions Handler ===================
bot.hears(/💰\s*Transactions/i, async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    const pageSize = 5; // Number of transactions per page
    const userState = await getUserState(userId);
    const transactionsSnapshot = await db.collection('transactions').where('userId', '==', userId).orderBy('timestamp', 'desc').limit(100).get(); // Fetch latest 100 transactions
    const transactionList = transactionsSnapshot.docs.map(doc => doc.data());

    if (transactionList.length === 0) {
      return ctx.replyWithMarkdown('❌ You have no transactions.');
    }

    // Implement Pagination
    const totalPages = Math.ceil(transactionList.length / pageSize);
    ctx.session.transactionsPage = 1; // Initialize to first page

    const generateTransactionPage = (page) => {
      const start = (page - 1) * pageSize;
      const end = start + pageSize;
      const transactions = transactionList.slice(start, end);

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

    const { message, inlineKeyboard } = generateTransactionPage(ctx.session.transactionsPage);
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
    const transactionsSnapshot = await db.collection('transactions').where('userId', '==', userId).orderBy('timestamp', 'desc').limit(100).get();
    const transactionList = transactionsSnapshot.docs.map(doc => doc.data());
    const totalPages = Math.ceil(transactionList.length / pageSize);

    if (requestedPage < 1 || requestedPage > totalPages) {
      return ctx.answerCbQuery('⚠️ Invalid page number.', { show_alert: true });
    }

    ctx.session.transactionsPage = requestedPage;

    const start = (requestedPage - 1) * pageSize;
    const end = start + pageSize;
    const transactions = transactionList.slice(start, end);

    let message = `💰 *Your Transactions* (Page ${requestedPage}/${totalPages}):\n\n`;
    transactions.forEach((tx, index) => {
      message += `*Transaction ${start + index + 1}:*\n`;
      message += `• *Reference ID:* \`${tx.referenceId || 'N/A'}\`\n`;
      message += `• *Amount:* ${tx.amount || 'N/A'} ${tx.asset || 'N/A'}\n`;
      message += `• *Status:* ${tx.status || 'Pending'}\n`;
      message += `• *Date:* ${tx.timestamp ? new Date(tx.timestamp).toLocaleString() : 'N/A'}\n`;
      message += `• *Chain:* ${tx.chain || 'N/A'}\n\n`;
    });

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
    logger.error(`Error navigating transaction pages for user ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred while navigating transactions. Please try again later.');
    ctx.answerCbQuery();
  }
});

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
 * Handle Admin Menu Actions
 */
bot.action(/admin_(.+)/, async (ctx) => {
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
              `*Amount:* ${txData.amount} ${txData.asset}\n` +
              `*Bank:* ${txData.bankDetails.bankName || 'N/A'}\n` +
              `*Account Name:* ${accountName}\n` +
              `*Account Number:* ****${txData.bankDetails.accountNumber.slice(-4)}\n` +
              `*Payout (NGN):* ₦${payout}\n\n` +
              `🔹 *Chain:* ${txData.chain}\n` +
              `*Date:* ${new Date(txData.timestamp).toLocaleString()}\n`,
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

        // Initiate broadcast message collection
        ctx.session.awaitingBroadcastMessage = true;
        await ctx.replyWithMarkdown('📢 Please enter the message you want to broadcast to all users. You can also attach an image with your message:');
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
      await ctx.answerCbQuery('⚠️ Unknown action. Please select an option from the menu.', { show_alert: true });
  }
});

// Handle Broadcast Message (After Admin inputs message)
bot.on('message', async (ctx, next) => {
  const userId = ctx.from.id.toString();
  if (isAdmin(userId) && ctx.session.awaitingBroadcastMessage) {
    const messageContent = ctx.message.text ? ctx.message.text.trim() : '';
    const photo = ctx.message.photo;

    if (!messageContent && !photo) {
      await ctx.replyWithMarkdown('❌ Message cannot be empty. Please enter a valid message or attach a photo.');
      return;
    }

    const usersSnapshot = await db.collection('users').get();
    if (usersSnapshot.empty) {
      await ctx.replyWithMarkdown('⚠️ No users found to send the broadcast message.');
      ctx.session.awaitingBroadcastMessage = false;
      return;
    }

    const sendPromises = [];

    usersSnapshot.forEach((doc) => {
      const userId = doc.id;
      if (photo) {
        const highestResolutionPhoto = photo[photo.length - 1];
        const fileId = highestResolutionPhoto.file_id;
        const caption = ctx.message.caption || '';

        sendPromises.push(
          bot.telegram.sendPhoto(userId, fileId, { caption: `📢 *Broadcast Message:*\n\n${caption}`, parse_mode: 'Markdown' })
        );
      } else if (messageContent) {
        sendPromises.push(
          bot.telegram.sendMessage(userId, `📢 *Broadcast Message:*\n\n${messageContent}`, { parse_mode: 'Markdown' })
        );
      }
    });

    try {
      await Promise.all(sendPromises);
      await ctx.replyWithMarkdown('✅ Broadcast message sent to all users.');
      logger.info(`Admin ${userId} sent a broadcast message: "${messageContent}" to ${usersSnapshot.size} users.`);
    } catch (error) {
      logger.error(`Error sending broadcast message: ${error.message}`);
      await ctx.replyWithMarkdown('⚠️ An error occurred while sending the broadcast message. Please try again later.');
    }

    ctx.session.awaitingBroadcastMessage = false;
  } else {
    return next();
  }
});

// =================== Admin Menu Navigation ===================
bot.action('admin_back_to_main', async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isAdmin(userId)) {
    return ctx.reply('⚠️ Unauthorized access.');
  }

  // Edit the admin panel message back to the main admin menu
  try {
    await ctx.editMessageText('👨‍💼 **Admin Panel**\n\nSelect an option below:', { reply_markup: getAdminMenu().reply_markup, parse_mode: 'Markdown' });
    ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Error navigating back to admin menu: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred while navigating the admin menu.');
    ctx.answerCbQuery();
  }
});

// =================== Additional Helper Functions ===================

/**
 * Generates a wallet address.
 * @param {string} chain - Chain name.
 * @returns {string} - Generated wallet address.
 */
async function generateWallet(chain) {
  // Implement wallet generation logic here
  // This is a placeholder example
  // You might integrate with a wallet generation API or library
  // For demonstration, we'll return a mock address
  return `0x${crypto.randomBytes(20).toString('hex')}`;
}

// =================== Exchange Rate Fetching ===================
const SUPPORTED_ASSETS = ['USDC', 'USDT'];
let exchangeRates = {
  USDC: 0,
  USDT: 0
};

/**
 * Fetches the exchange rate for a specific asset from Paycrest.
 * @param {string} asset - Asset symbol.
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
const PAYCREST_RATE_UPDATE_INTERVAL = 5 * 60 * 1000; // 5 minutes in milliseconds
setInterval(fetchExchangeRates, PAYCREST_RATE_UPDATE_INTERVAL);

// =================== Apply Global Middleware ===================

// **Global bodyParser.json() is applied after webhook routes to prevent interference**
app.use(bodyParser.json());

// =================== Start Express Server ===================
app.listen(PORT, () => {
  logger.info(`Express server listening on port ${PORT}`);
});

// =================== Shutdown Handlers ===================
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

// =================== Additional Bot Handlers ===================

/**
 * Generates the Main Menu Keyboard.
 * @param {boolean} walletExists - Whether the user has wallets.
 * @param {boolean} hasBankLinked - Whether the user has a linked bank account.
 * @returns {Markup} - Keyboard Markup.
 */
// Removed duplicate getMainMenuKeyboard function

// =================== Handle Bank Linking ===================
bot.hears('🏦 Link Bank Account', async (ctx) => {
  const userId = ctx.from.id.toString();
  try {
    const userState = await getUserState(userId);
    
    if (userState.wallets.length === 0) {
      return ctx.replyWithMarkdown('❌ You have no wallets. Please generate a wallet first using the "💼 Generate Wallet" option.');
    }

    // If only one wallet, proceed to link bank
    if (userState.wallets.length === 1) {
      ctx.session.walletIndex = 0;
      await ctx.scene.enter('bank_linking_scene');
    } else {
      // Multiple wallets, prompt user to select which wallet to link bank
      let keyboard = userState.wallets.map((wallet, index) => [
        Markup.button.callback(`Wallet ${index + 1} - ${wallet.chain}`, `select_wallet_link_bank_${index}`)
      ]);
      await ctx.reply('Please select the wallet for which you want to link a bank account:', Markup.inlineKeyboard(keyboard));
    }
  } catch (error) {
    logger.error(`Error initiating bank linking for user ${userId}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ An error occurred while initiating the bank linking. Please try again later.');
  }
});

// Handle Wallet Selection for Linking Bank
bot.action(/select_wallet_link_bank_(\d+)/, async (ctx) => {
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

// =================== View Current Rates Handler ===================
bot.hears(/📈\s*View Current Rates/i, async (ctx) => {
  try {
    let ratesMessage = '📈 *Current Exchange Rates*:\n\n';
    for (const [asset, rate] of Object.entries(exchangeRates)) {
      ratesMessage += `• *${asset}*: ₦${rate}\n`;
    }
    ratesMessage += `\nThese rates are updated every 5 minutes.`;
    await ctx.replyWithMarkdown(ratesMessage);
  } catch (error) {
    logger.error(`Error fetching current rates for user ${ctx.from.id}: ${error.message}`);
    await ctx.replyWithMarkdown('⚠️ Unable to fetch current rates. Please try again later.');
  }
});
