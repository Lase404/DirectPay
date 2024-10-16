// index.js

// Required Modules
const Web3 = require('web3');
const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const admin = require('firebase-admin');
const express = require('express');
const fs = require('fs');
const path = require('path');


// Firebase Admin Setup
const serviceAccount = require('./directpayngn1-75dd09c81338.json'); // Path from .env

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://directpayngn1.firebaseio.com" // Ensure this matches your project
});

const db = admin.firestore();

// API Keys (set environment variables)
const BOT_TOKEN = '8177636867:AAFXgCtKhqc4pcs8VeRUdAZVcwCXjQLEABk'; // Your actual Bot Token
const PAYSTACK_API_KEY = 'sk_test_cd857e88d5d474db8238d30d027ea2911cd7fa17';
const BLOCKRADAR_API_KEY = '6HGRj2cdzULDUbrjGHZftwNyHswUZojxA40mQp77e5vDzWqJ6v13w2iE4DBHzu'; 
const BLOCKRADAR_WALLET_ID = '2cab1ef2-8589-4ff9-9017-76cc4d067719'; // Blockradar Wallet ID for BSC
const PERSONAL_CHAT_ID = '2009305288';


// Web3 Setup for Base Testnet
const web3 = new Web3('https://sepolia.base.org');

// Bot Initialization
const bot = new Telegraf(BOT_TOKEN);
const app = express();
app.use(express.json());

// State Management is handled via Firestore

const MAX_WALLETS = 3; // Max wallets per user

// Manual Bank List
const bankList = [
  { name: 'Access Bank', code: '044' },
  { name: 'GTBank', code: '058' },
  { name: 'Zenith Bank', code: '057' },
  // Add all banks here
];

// Utility Functions

/**
 * Retrieves the user state from Firestore.
 * If the user does not exist, initializes their state.
 * @param {string} userId - Telegram user ID
 * @returns {object} - User state object
 */
async function getUserState(userId) {
  try {
    const userDoc = await db.collection('users').doc(userId).get();
    if (!userDoc.exists) {
      const initialState = { wallets: [], awaitingBankName: false, awaitingAccountNumber: false, currentWalletIndex: null };
      await db.collection('users').doc(userId).set(initialState);
      return initialState;
    }
    return userDoc.data();
  } catch (error) {
    console.error(`Error fetching user state for ${userId}:`, error);
    throw new Error('Unable to retrieve user state.');
  }
}

/**
 * Updates the user state in Firestore.
 * @param {string} userId - Telegram user ID
 * @param {object} newState - Partial state object to update
 */
async function updateUserState(userId, newState) {
  try {
    await db.collection('users').doc(userId).update(newState);
  } catch (error) {
    console.error(`Error updating user state for ${userId}:`, error);
    throw new Error('Unable to update user state.');
  }
}

/**
 * Verifies a bank account using Paystack API.
 * @param {string} accountNumber
 * @param {string} bankCode
 * @returns {object} Paystack response data
 */
async function verifyBankAccount(accountNumber, bankCode) {
  try {
    const response = await axios.get(`https://api.paystack.co/bank/resolve`, {
      params: { account_number: accountNumber, bank_code: bankCode },
      headers: { Authorization: `Bearer ${PAYSTACK_API_KEY}` },
    });
    return response.data;
  } catch (error) {
    console.error('Paystack Verification Error:', error.response ? error.response.data : error.message);
    throw new Error('Failed to verify bank account. Please try again later.');
  }
}

/**
 * Calculates payout based on asset type and amount.
 * @param {string} asset
 * @param {number} amount
 * @returns {string} Calculated payout in NGN
 */
function calculatePayout(asset, amount) {
  const rates = { USDC: 1641.81, USDT: 1641.81, ETH: 3968483.33 };
  return (amount * rates[asset]).toFixed(2);
}

/**
 * Generates a unique reference ID for transactions.
 * @returns {string} Reference ID
 */
function generateReferenceId() {
  return 'REF-' + Math.random().toString(36).substr(2, 9).toUpperCase();
}

/**
 * Retrieves the main menu keyboard based on wallet existence.
 * @param {boolean} walletExists
 * @returns {Markup} Keyboard markup
 */
const getMainMenu = (walletExists) =>
  Markup.keyboard([
    [walletExists ? '💼 View Wallet' : '💼 Generate Wallet', '🏦 Link Bank Account'],
    ['💰 Transactions', 'ℹ️ Support', '📘 Learn About Base'],
  ]).resize();

// Admin-only Menu
const adminMenu = Markup.inlineKeyboard([
  [Markup.button.callback('View Transactions', 'admin_view_transactions')],
  [Markup.button.callback('Send Message', 'admin_send_message')],
  [Markup.button.callback('Mark Paid', 'admin_mark_paid')],
]);

/**
 * Checks if the user is an admin.
 * @param {string} userId
 * @returns {boolean}
 */
const isAdmin = (userId) => userId.toString() === PERSONAL_CHAT_ID;

/**
 * Greets the user based on their wallet status.
 * @param {Context} ctx
 */
async function greetUser(ctx) {
  const userId = ctx.from.id.toString();
  let userState;
  try {
    userState = await getUserState(userId);
  } catch (error) {
    console.error('Error in greetUser:', error);
    return ctx.reply('An error occurred while accessing your data. Please try again later.');
  }

  const walletExists = userState.wallets.length > 0;

  const greeting = walletExists
    ? `👋 Hey, ${ctx.from.first_name}! Welcome to DirectPay!\n\nSay goodbye to delays and complicated P2P transactions. With DirectPay, you can easily send stablecoins and receive cash directly in your bank account within minutes. No KYC, no hassle—just quick and secure transactions.\n\nLet’s get started!\n\n1. **Add Your Bank Account**\n2. **Get Your Dedicated Wallet Address**\n3. **Send Stablecoins and receive cash instantly.**\n\nWe’ve got the best rates and real-time updates to keep you informed every step of the way. Your funds are safe, and you’ll have cash in your account in no time!`
    : `👋 Hello, ${ctx.from.first_name}! Welcome to DirectPay. Let's get started with your crypto journey.`;

  return ctx.reply(greeting, getMainMenu(walletExists));
}

// Handle /start Command
bot.start(async (ctx) => {
  try {
    await greetUser(ctx);
  } catch (error) {
    console.error('Error in /start command:', error);
    await ctx.reply('An error occurred. Please try again later.');
  }
});

/**
 * Generates a new Base wallet using BlockRadar API.
 * @returns {string} Wallet Address
 */
async function generateBaseWallet() {
  try {
    const response = await axios.post(
      `https://api.blockradar.co/v1/wallets/${BLOCKRADAR_WALLET_ID}/addresses`,
      { name: 'DirectPay_User_Wallet' },
      { headers: { 'x-api-key': BLOCKRADAR_API_KEY } }
    );
    return response.data.data.address;
  } catch (error) {
    console.error('BlockRadar Wallet Generation Error:', error.response ? error.response.data : error.message);
    throw new Error('Error generating wallet');
  }
}

// Wallet Generation and Viewing

/**
 * Generates a new wallet for the user.
 * @param {Context} ctx
 */
bot.hears('💼 Generate Wallet', async (ctx) => {
  const userId = ctx.from.id.toString();
  let userState;

  try {
    userState = await getUserState(userId);
  } catch (error) {
    console.error('Error fetching user state:', error);
    return ctx.reply('⚠️ Unable to process your request at the moment. Please try again later.');
  }

  if (userState.wallets.length >= MAX_WALLETS) {
    return ctx.reply(`⚠️ You cannot generate more than ${MAX_WALLETS} wallets.`);
  }

  const generatingMessage = await ctx.reply('🔄 Generating Wallet... Please wait a moment.');

  try {
    const walletAddress = await generateBaseWallet();
    userState.wallets.push({ address: walletAddress, bank: null });
    await updateUserState(userId, { wallets: userState.wallets });

    // Update Menu
    await ctx.reply(`✅ Success! Your new wallet has been generated:\n\n\`${walletAddress}\``, getMainMenu(true));

    // Prompt to Link Bank Account
    await ctx.reply('Please link a bank account to receive your payouts.', Markup.keyboard(['🏦 Link Bank Account']).resize());

    await ctx.deleteMessage(generatingMessage.message_id);

    // Log Wallet Generation
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `💼 Wallet generated for user ${userId}: ${walletAddress}`);
  } catch (error) {
    console.error('Error generating wallet:', error);
    await ctx.reply('⚠️ There was an issue generating your wallet. Please try again later.');
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ Error generating wallet for user ${userId}: ${error.message}`);
  }
});

/**
 * Displays the user's wallets.
 * @param {Context} ctx
 */
bot.hears('💼 View Wallet', async (ctx) => {
  const userId = ctx.from.id.toString();
  let userState;

  try {
    userState = await getUserState(userId);
  } catch (error) {
    console.error('Error fetching user state:', error);
    return ctx.reply('⚠️ Unable to fetch your wallets at the moment. Please try again later.');
  }

  if (userState.wallets.length === 0) {
    return ctx.reply('You have no wallets. Generate a new wallet below.', getMainMenu(false));
  }

  // Display Wallets
  let walletMessage = '💼 **Your Wallets**:\n\n';
  userState.wallets.forEach((wallet, index) => {
    walletMessage += `#${index + 1} Wallet Address: \`${wallet.address}\`\n`;
    walletMessage += `🔗 Linked Bank: ${wallet.bank ? 'Yes' : 'No'}\n\n`;
  });

  const canCreateNewWallet = userState.wallets[0].bank;

  await ctx.reply(walletMessage, Markup.inlineKeyboard([
    canCreateNewWallet
      ? [Markup.button.callback('Create New Wallet', 'create_new_wallet')]
      : [Markup.button.callback('Link Bank to Create New Wallet', 'link_bank')],
  ]));
});

/**
 * Creates a new wallet for the user if conditions are met.
 * @param {Context} ctx
 */
bot.action('create_new_wallet', async (ctx) => {
  const userId = ctx.from.id.toString();
  let userState;

  try {
    userState = await getUserState(userId);
  } catch (error) {
    console.error('Error fetching user state:', error);
    return ctx.reply('⚠️ Unable to process your request at the moment. Please try again later.');
  }

  if (!userState.wallets[0].bank) {
    return ctx.reply('⚠️ You must link a bank to your first wallet before creating a new one.');
  }

  if (userState.wallets.length >= MAX_WALLETS) {
    return ctx.reply(`⚠️ You cannot generate more than ${MAX_WALLETS} wallets.`);
  }

  const generatingMessage = await ctx.reply('🔄 Generating a new wallet... Please wait a moment.');

  try {
    const walletAddress = await generateBaseWallet();
    userState.wallets.push({ address: walletAddress, bank: null });
    await updateUserState(userId, { wallets: userState.wallets });

    await ctx.reply(`✅ Success! Your new wallet has been generated:\n\n\`${walletAddress}\``, getMainMenu(true));

    await ctx.deleteMessage(generatingMessage.message_id);

    // Log Wallet Generation
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `💼 New wallet generated for user ${userId}: ${walletAddress}`);
  } catch (error) {
    console.error('Error generating new wallet:', error);
    await ctx.reply('⚠️ There was an issue generating your wallet. Please try again later.');
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ Error generating new wallet for user ${userId}: ${error.message}`);
  }
});

/**
 * Initiates the bank linking process for the user.
 * @param {Context} ctx
 */
bot.hears('🏦 Link Bank Account', async (ctx) => {
  const userId = ctx.from.id.toString();
  let userState;

  try {
    userState = await getUserState(userId);
  } catch (error) {
    console.error('Error fetching user state:', error);
    return ctx.reply('⚠️ Unable to process your request at the moment. Please try again later.');
  }

  if (userState.wallets.length === 0) {
    return ctx.reply('⚠️ You need to generate a wallet before linking a bank account.');
  }

  const walletIndex = userState.wallets.findIndex((wallet) => !wallet.bank);

  if (walletIndex === -1) {
    return ctx.reply('All your wallets already have a linked bank account.');
  }

  // Update user state to indicate awaiting bank name
  await updateUserState(userId, {
    currentWalletIndex: walletIndex,
    awaitingBankName: true,
    awaitingAccountNumber: false,
  });

  await ctx.reply('Please enter your bank name (e.g., Access Bank):');
});

/**
 * Handles text messages for bank linking.
 * @param {Context} ctx
 */
bot.on('text', async (ctx) => {
  const userId = ctx.from.id.toString();
  let userState;

  try {
    userState = await getUserState(userId);
  } catch (error) {
    console.error('Error fetching user state:', error);
    return ctx.reply('⚠️ Unable to process your request at the moment. Please try again later.');
  }

  if (userState.awaitingBankName) {
    const bankName = ctx.message.text.trim();
    const bank = bankList.find((b) => b.name.toLowerCase() === bankName.toLowerCase());

    if (!bank) {
      return ctx.reply('❌ Invalid bank name. Please enter a valid bank name:');
    }

    await updateUserState(userId, {
      bankCode: bank.code,
      bankName: bank.name,
      awaitingBankName: false,
      awaitingAccountNumber: true,
    });

    return ctx.reply('Please enter your bank account number (10 digits):');
  } else if (userState.awaitingAccountNumber) {
    const accountNumber = ctx.message.text.trim();

    if (!/^\d{10}$/.test(accountNumber)) {
      return ctx.reply('❌ Invalid account number. Please enter a valid 10-digit account number:');
    }

    await updateUserState(userId, {
      accountNumber: accountNumber,
      awaitingAccountNumber: false,
    });

    // Verify Bank Account
    await ctx.reply('🔄 Verifying your bank details...');

    try {
      const verificationResult = await verifyBankAccount(accountNumber, userState.bankCode);
      const accountName = verificationResult.data.account_name;

      // Update user state with account name
      await updateUserState(userId, {
        accountName: accountName,
      });

      // Ask for confirmation
      await ctx.reply(
        `🏦 **Bank Account Verification**\n\nBank Name: *${userState.bankName}*\nAccount Number: *${accountNumber}*\nAccount Holder: *${accountName}*\n\nIs this correct?`,
        Markup.inlineKeyboard([
          Markup.button.callback('✅ Yes', 'confirm_bank_yes'),
          Markup.button.callback('❌ No', 'confirm_bank_no'),
        ])
      );
    } catch (error) {
      console.error('Error verifying bank account:', error);
      await ctx.reply('❌ Failed to verify bank account. Please try again later.');
      await updateUserState(userId, {
        awaitingBankName: true,
        awaitingAccountNumber: false,
      });
      return ctx.reply('Please enter your bank name (e.g., Access Bank):');
    }
  }
});

/**
 * Handles confirmation of bank account details.
 * @param {Context} ctx
 */
bot.action('confirm_bank_yes', async (ctx) => {
  const userId = ctx.from.id.toString();
  let userState;

  try {
    userState = await getUserState(userId);
  } catch (error) {
    console.error('Error fetching user state:', error);
    return ctx.reply('⚠️ Unable to process your request at the moment. Please try again later.');
  }

  const walletIndex = userState.currentWalletIndex;

  if (walletIndex === null || walletIndex >= userState.wallets.length) {
    return ctx.reply('⚠️ Invalid wallet index. Please try linking your bank account again.');
  }

  // Update wallet with bank details
  userState.wallets[walletIndex].bank = {
    bankName: userState.bankName,
    bankCode: userState.bankCode,
    accountNumber: userState.accountNumber,
    accountName: userState.accountName,
  };

  // Update Firestore
  await updateUserState(userId, {
    wallets: userState.wallets,
    bankName: null,
    bankCode: null,
    accountNumber: null,
    accountName: null,
    currentWalletIndex: null,
  });

  await ctx.reply('✅ Your bank account has been linked successfully!', getMainMenu(true));

  // Log to Admin
  await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `🔗 User ${userId} linked a bank account: ${JSON.stringify(userState.wallets[walletIndex].bank)}`);
});

/**
 * Handles rejection of bank account details.
 * @param {Context} ctx
 */
bot.action('confirm_bank_no', async (ctx) => {
  const userId = ctx.from.id.toString();
  let userState;

  try {
    userState = await getUserState(userId);
  } catch (error) {
    console.error('Error fetching user state:', error);
    return ctx.reply('⚠️ Unable to process your request at the moment. Please try again later.');
  }

  await ctx.reply('⚠️ It seems there was an error. Let\'s try again.');

  // Reset Firestore state
  await updateUserState(userId, {
    bankName: null,
    bankCode: null,
    accountNumber: null,
    accountName: null,
    awaitingBankName: true,
    awaitingAccountNumber: false,
  });

  return ctx.reply('Please enter your bank name (e.g., Access Bank):');
});

/**
 * Sends paginated content about Base.
 * @param {Context} ctx
 * @param {number} index
 */
async function sendBaseContent(ctx, index) {
  const content = baseContent[index];
  const totalPages = baseContent.length;

  const navigationButtons = [];

  if (index > 0) {
    navigationButtons.push(Markup.button.callback('⬅️ Back', `base_page_${index - 1}`));
  }

  if (index < totalPages - 1) {
    navigationButtons.push(Markup.button.callback('Next ➡️', `base_page_${index + 1}`));
  }

  await ctx.replyWithMarkdown(`*${content.title}*\n\n${content.text}`, Markup.inlineKeyboard(navigationButtons));
}

// Learn About Base with Pagination
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
    text: 'To start using Base, you can bridge your assets from Ethereum to Base using the official bridge at https://base.org/bridge.',
  },
  {
    title: 'Learn More',
    text: 'Visit the official documentation at https://docs.base.org for in-depth guides and resources.',
  },
];

/**
 * Learn About Base Functionality
 * Provides users with information about Base network in a paginated format.
 */
bot.hears('📘 Learn About Base', async (ctx) => {
  await sendBaseContent(ctx, 0);
});

// Handle Base Content Pagination
bot.action(/base_page_(\d+)/, async (ctx) => {
  const index = parseInt(ctx.match[1], 10);
  if (index >= 0 && index < baseContent.length) {
    await sendBaseContent(ctx, index);
  } else {
    await ctx.reply('⚠️ Invalid page number.');
  }
});

/**
 * Support Functionality
 * Provides users with support options.
 */
bot.hears('ℹ️ Support', async (ctx) => {
  await ctx.reply('How can we assist you today?', Markup.inlineKeyboard([
    [Markup.button.callback('❓ How It Works', 'support_how_it_works')],
    [Markup.button.callback('⚠️ Transaction Not Received', 'support_not_received')],
    [Markup.button.callback('💬 Contact Support', 'support_contact')],
  ]));
});

// Support Actions
bot.action('support_how_it_works', async (ctx) => {
  await ctx.reply('DirectPay allows you to receive crypto payments directly into your bank account seamlessly. Generate a wallet, link your bank, and start receiving payments.');
});

bot.action('support_not_received', async (ctx) => {
  await ctx.reply('If you haven’t received your transaction, please ensure that you have linked your bank account. If the issue persists, contact support.');
});

bot.action('support_contact', async (ctx) => {
  await ctx.reply('You can contact our support team at @your_support_username.');
});

/**
 * View Transactions for Users
 * Allows users to view their transaction history.
 */
bot.hears('💰 Transactions', async (ctx) => {
  const userId = ctx.from.id.toString();
  let userState;

  try {
    userState = await getUserState(userId);
  } catch (error) {
    console.error('Error fetching user state:', error);
    return ctx.reply('⚠️ Unable to fetch your transactions at the moment. Please try again later.');
  }

  try {
    const transactionsSnapshot = await db.collection('transactions').where('userId', '==', userId).get();

    if (transactionsSnapshot.empty) {
      return ctx.reply('You have no transactions at the moment.');
    }

    let message = '💰 **Your Transactions**:\n\n';

    transactionsSnapshot.forEach((doc) => {
      const tx = doc.data();
      message += `🔹 Reference ID: ${tx.referenceId}\n🔹 Amount: ${tx.amount} ${tx.asset}\n🔹 Status: ${tx.status || 'Pending'}\n🔹 Date: ${tx.timestamp.toDate().toLocaleString()}\n\n`;
    });

    await ctx.replyWithMarkdown(message);
  } catch (error) {
    console.error('Error fetching transactions:', error);
    await ctx.reply('⚠️ Unable to fetch transactions. Please try again later.');
  }
});

/**
 * Admin Functions
 * Allows admin to view all transactions, send messages, and mark transactions as paid.
 */
bot.action(/admin_(.+)/, async (ctx) => {
  const userId = ctx.from.id.toString();

  if (!isAdmin(userId)) {
    return ctx.reply('⚠️ Unauthorized access.');
  }

  const action = ctx.match[1];

  if (action === 'view_transactions') {
    // Fetch and display all transactions
    try {
      const transactionsSnapshot = await db.collection('transactions').get();

      if (transactionsSnapshot.empty) {
        return ctx.reply('No transactions found.');
      }

      let message = '💰 **All Transactions**:\n\n';

      transactionsSnapshot.forEach((doc) => {
        const tx = doc.data();
        message += `🔹 User ID: ${tx.userId}\n🔹 Reference ID: ${tx.referenceId}\n🔹 Amount: ${tx.amount} ${tx.asset}\n🔹 Status: ${tx.status || 'Pending'}\n🔹 Date: ${tx.timestamp.toDate().toLocaleString()}\n\n`;
      });

      await ctx.replyWithMarkdown(message);
    } catch (error) {
      console.error('Error fetching transactions:', error);
      await ctx.reply('⚠️ Unable to fetch transactions.');
    }
  } else if (action === 'send_message') {
    // Set admin state to await user ID and message
    await updateUserState(userId, {
      awaitingUserIdForMessage: true,
      messageRecipientId: null,
      awaitingMessageContent: false,
    });

    await ctx.reply('Please enter the User ID you want to message:');
  } else if (action === 'mark_paid') {
    // Functionality to mark pending transactions as paid
    try {
      const pendingTransactionsSnapshot = await db.collection('transactions').where('status', '==', 'Pending').get();
      if (pendingTransactionsSnapshot.empty) {
        return ctx.reply('No pending transactions found.');
      }

      let successCount = 0;
      let failCount = 0;

      const batch = db.batch();

      pendingTransactionsSnapshot.forEach((transaction) => {
        const data = transaction.data();
        const transactionRef = db.collection('transactions').doc(transaction.id);
        batch.update(transactionRef, { status: 'Paid' });

        // Notify the user
        bot.telegram.sendMessage(data.userId, `🎉 Your transaction with reference ID ${data.referenceId} has been marked as paid!`)
          .then(() => {
            successCount++;
          })
          .catch((error) => {
            console.error(`Error notifying user ${data.userId}:`, error);
            failCount++;
          });
      });

      await batch.commit();

      await ctx.reply(`✅ Marked ${successCount} transactions as paid. ${failCount > 0 ? `⚠️ Failed to notify ${failCount} users.` : ''}`);
    } catch (error) {
      console.error('Error marking transactions as paid:', error);
      await ctx.reply('⚠️ Error marking transactions as paid. Please try again later.');
    }
  }
});

/**
 * Handle Admin Messaging Inputs
 * Parses the user ID and message content from admin input.
 */
bot.on('text', async (ctx) => {
  const userId = ctx.from.id.toString();
  let userState;

  try {
    userState = await getUserState(userId);
  } catch (error) {
    console.error('Error fetching user state:', error);
    return ctx.reply('⚠️ Unable to process your request at the moment. Please try again later.');
  }

  if (isAdmin(userId) && userState.awaitingUserIdForMessage) {
    const recipientId = ctx.message.text.trim();
    if (!/^\d+$/.test(recipientId)) {
      return ctx.reply('❌ Invalid User ID. Please enter a valid numeric User ID:');
    }

    await updateUserState(userId, {
      messageRecipientId: recipientId,
      awaitingUserIdForMessage: false,
      awaitingMessageContent: true,
    });

    return ctx.reply('Please enter the message you want to send:');
  } else if (isAdmin(userId) && userState.awaitingMessageContent) {
    const recipientId = userState.messageRecipientId;
    const messageContent = ctx.message.text.trim();

    if (!recipientId || !messageContent) {
      return ctx.reply('❌ Please provide both User ID and the message.');
    }

    try {
      await bot.telegram.sendMessage(recipientId, `📩 Message from Admin:\n\n${messageContent}`);
      await ctx.reply('✅ Message sent successfully.');
    } catch (error) {
      console.error('Error sending message to user:', error);
      await ctx.reply('⚠️ Failed to send message to the user. Please ensure the User ID is correct.');
    }

    // Reset admin state
    await updateUserState(userId, {
      messageRecipientId: null,
      awaitingMessageContent: false,
    });
  }
});

/**
 * Webhook Handler for Deposits
 * Processes deposit events from BlockRadar.
 */
app.post('/webhook/blockradar', async (req, res) => {
  try {
    const event = req.body;
    console.log('Received webhook:', JSON.stringify(event, null, 2));
    fs.appendFileSync(path.join(__dirname, 'webhook_logs.txt'), `${new Date().toISOString()} - ${JSON.stringify(event, null, 2)}\n`);

    // Log to Admin
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `🔔 Webhook Event Received:\n${JSON.stringify(event, null, 2)}`);

    if (event.event === 'deposit.success') {
      const walletAddress = event.data.address.address;
      const amount = event.data.amount;
      const asset = event.data.asset.symbol;
      const transactionHash = event.data.hash;

      // Find User by Wallet Address
      const usersSnapshot = await db.collection('users').where('wallets.address', '==', walletAddress).get();
      if (usersSnapshot.empty) {
        console.log(`No user found for wallet ${walletAddress}`);
        return res.status(200).send('OK');
      }

      const userDoc = usersSnapshot.docs[0];
      const userId = userDoc.id;
      const userState = userDoc.data();

      const wallet = userState.wallets.find((w) => w.address === walletAddress);

      // Check if Wallet has Linked Bank
      if (!wallet.bank) {
        await bot.telegram.sendMessage(userId, `💰 Deposit Received: ${amount} ${asset}. Please link a bank account to receive your payout securely.`);
        await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `⚠️ User ${userId} has received a deposit but hasn't linked a bank account.`);
        return res.status(200).send('OK');
      }

      const payout = calculatePayout(asset, amount);
      const referenceId = generateReferenceId();
      const bankName = wallet.bank.bankName;
      const bankAccount = wallet.bank.accountNumber;
      const accountName = wallet.bank.accountName;
      const rate = payout / amount; // Assuming rate is payout divided by amount

      // Notify User of Successful Deposit with Detailed Message
      await bot.telegram.sendMessage(userId,
        `Hello ${accountName},\n\nA deposit of ${amount} ${asset} was received on your wallet address: \`${walletAddress}\`.\n\nYour transaction is being processed at the rate of NGN ${rate} per ${asset}. You’ll receive NGN ${payout} in your ${bankName} ******${bankAccount.slice(-4)} account shortly.\n\nStay based, onchain dreamer. We'll notify you once the process is complete.`,
        Markup.inlineKeyboard([
          Markup.button.callback('📊 View Transaction', `view_transaction_${transactionHash}`)
        ])
      );

      // Notify Admin with Transaction Details
      await bot.telegram.sendMessage(PERSONAL_CHAT_ID,
        `⚡️ User ${userId} received ${amount} ${asset} on wallet ${walletAddress}.\n\n📝 Transaction ID: ${transactionHash}\n🔗 Reference ID: ${referenceId}\n\nProcessing NGN ${payout} to ${bankName} ******${bankAccount.slice(-4)} now.`
      );

      // Store Transaction in Firestore
      await db.collection('transactions').add({
        userId,
        walletAddress,
        amount,
        asset,
        transactionHash,
        referenceId,
        bankDetails: wallet.bank,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        status: 'Pending',
      });

      // Log to Admin
      await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `🗄 Transaction stored in Firebase for user ${userId}.`);

      return res.status(200).send('OK');
    }

    // If event is not 'deposit.success', just acknowledge
    return res.status(200).send('OK');
  } catch (error) {
    console.error('Error processing webhook:', error);
    res.status(500).send('Error');
    await bot.telegram.sendMessage(PERSONAL_CHAT_ID, `❗️ Error processing webhook: ${error.message}`);
  }
});

/**
 * Start Express Server
 */
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Webhook server running on port ${PORT}`);
});

/**
 * Launch the Bot
 */
bot.launch()
  .then(() => console.log('DirectPay bot is live!'))
  .catch((err) => console.error('Error launching bot:', err));

/**
 * Graceful Shutdown
 */
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
