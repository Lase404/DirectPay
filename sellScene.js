const { Scenes, Markup } = require('telegraf');
const axios = require('axios');
const admin = require('firebase-admin');
const { v4: uuidv4 } = require('uuid');

// Firebase Firestore (from bot.js)
const db = admin.firestore();

// Logger (from bot.js)
const logger = require('winston').createLogger({
  level: 'info',
  format: require('winston').format.combine(
    require('winston').format.timestamp(),
    require('winston').format.printf(({ timestamp, level, message }) => `[${timestamp}] ${level.toUpperCase()}: ${message}`)
  ),
  transports: [
    new require('winston').transports.Console(),
    new require('winston').transports.File({ filename: 'bot.log', maxsize: 5242880, maxFiles: 5 }),
  ],
});

// Network mapping (from bot.js, adjusted to match input style)
const networkMap = {
  eth: 1,
  base: 8453,
  sol: 792703809,
  polygon: 137,
  bnb: 56,
};

// getUserState (copied from bot.js)
async function getUserState(userId) {
  try {
    const userDoc = await db.collection('users').doc(userId).get();
    if (!userDoc.exists) {
      const defaultState = {
        firstName: '',
        wallets: [],
        walletAddresses: [],
        hasReceivedDeposit: false,
        awaitingBroadcastMessage: false,
        usePidgin: false,
        refundAddress: null,
      };
      await db.collection('users').doc(userId).set(defaultState);
      logger.info(`Initialized default user state for ${userId}`);
      return defaultState;
    }
    const data = userDoc.data();
    return {
      firstName: data.firstName || '',
      wallets: data.wallets || [],
      walletAddresses: data.walletAddresses || [],
      hasReceivedDeposit: data.hasReceivedDeposit || false,
      awaitingBroadcastMessage: data.awaitingBroadcastMessage || false,
      usePidgin: data.usePidgin || false,
      refundAddress: data.refundAddress || null,
    };
  } catch (error) {
    logger.error(`Error fetching user state for ${userId}: ${error.message}`);
    return {
      firstName: '',
      wallets: [],
      walletAddresses: [],
      hasReceivedDeposit: false,
      awaitingBroadcastMessage: false,
      usePidgin: false,
      refundAddress: null,
    };
  }
}

// Sell Scene
const sellScene = new Scenes.WizardScene(
  'sell_scene',
  // Step 1: Enter amount and asset (with personalized default)
  async (ctx) => {
    const userId = ctx.from.id.toString();
    const userState = await getUserState(userId);
    const userDoc = await db.collection('users').doc(userId).get();
    const lastSell = userDoc.exists && userDoc.data().lastSell ? userDoc.data().lastSell : {};
    const defaultAsset = lastSell.asset || 'USDC';
    const prompt = userState.usePidgin
      ? `Step 1/5: Enter amount and asset (e.g., "10 ${defaultAsset}"). Last time you use ${defaultAsset}.`
      : `Step 1/5: Enter amount and asset (e.g., "10 ${defaultAsset}"). You last used ${defaultAsset}.`;
    await ctx.reply(prompt);
    ctx.wizard.state.data = { userId };
    return ctx.wizard.next();
  },
  // Step 2: Enter network
  async (ctx) => {
    const userState = await getUserState(ctx.wizard.state.data.userId);
    const input = ctx.message.text.trim().split(' ');
    const amount = parseFloat(input[0]);
    const asset = input[1]?.toUpperCase() || 'USDC';

    if (isNaN(amount) || amount <= 0) {
      const errorMsg = userState.usePidgin
        ? 'Invalid amount o. Use "10 USDC" format:'
        : 'Invalid amount. Use format "10 USDC":';
      await ctx.reply(errorMsg);
      return ctx.wizard.selectStep(1);
    }

    ctx.wizard.state.data.amount = amount;
    ctx.wizard.state.data.asset = asset;
    const prompt = userState.usePidgin
      ? 'Step 2/5: Enter network (e.g., "sol", "eth", "base"):'
      : 'Step 2/5: Enter the network (e.g., "sol", "eth", "base"):';
    await ctx.reply(prompt);
    return ctx.wizard.next();
  },
  // Step 3: Network validation, bank selection, and preview
  async (ctx) => {
    const networkInput = ctx.message.text.trim().toLowerCase();
    const chainId = networkMap[networkInput];
    const userState = await getUserState(ctx.wizard.state.data.userId);

    if (!chainId) {
      const errorMsg = userState.usePidgin
        ? 'Invalid network o. Use "sol", "eth", "base", etc.:'
        : 'Invalid network. Use "sol", "eth", "base", etc.:';
      await ctx.reply(errorMsg);
      return ctx.wizard.selectStep(2);
    }

    const { userId, amount, asset } = ctx.wizard.state.data;
    const userRef = db.collection('users').doc(userId);
    const userDoc = await userRef.get();
    const userData = userDoc.exists ? userDoc.data() : {};

    // Token validation with Relay (using axios from bot.js)
    const currencyRes = await axios
      .post(
        'https://api.relay.link/currencies/v1',
        {
          defaultList: true,
          chainIds: [chainId],
          term: asset,
          verified: true,
          limit: 1,
        },
        {
          headers: {
            'Content-Type': 'application/json'
          },
        }
      )
      .catch(async (err) => {
        logger.error(`Relay currency validation failed for ${asset} on ${networkInput}: ${err.message}`);
        const errorMsg = userState.usePidgin
          ? 'E get problem fetching token o. Retry?'
          : 'Error fetching token. Retry?';
        await ctx.reply(errorMsg, Markup.inlineKeyboard([[Markup.button.callback('Retry', 'retry_token')]]));
        return null;
      });

    if (!currencyRes) return;
    const token = currencyRes.data[0]?.[0];
    if (!token) {
      const errorMsg = userState.usePidgin
        ? `${asset} no dey on ${networkInput.toUpperCase()} o. Check am well.`
        : `${asset} not found on ${networkInput.toUpperCase()}. Please check your input.`;
      await ctx.reply(errorMsg);
      return ctx.scene.leave();
    }

    ctx.wizard.state.data.token = token;
    ctx.wizard.state.data.chainId = chainId;
    ctx.wizard.state.data.amountInWei = BigInt(Math.floor(amount * Math.pow(10, token.decimals))).toString();

    const linkedBank = userData.wallets?.[0]?.bank;
    let confirmMsg, keyboard;
    if (linkedBank) {
      confirmMsg = userState.usePidgin
        ? `Step 3/5: Sell ${amount} ${asset} on ${networkInput.toUpperCase()}.\nUsing bank: ${linkedBank.bankName} - ****${linkedBank.accountNumber.slice(-4)}\nYou wan use this bank or link new one?`
        : `Step 3/5: Sell ${amount} ${asset} on ${networkInput.toUpperCase()}.\nUsing bank: ${linkedBank.bankName} - ****${linkedBank.accountNumber.slice(-4)}\nUse this bank or link a new one?`;
      keyboard = [
        [Markup.button.callback('✅ Use This Bank', 'use_existing_bank'), Markup.button.callback('🏦 Link New Bank', 'link_new_bank')],
        [Markup.button.callback('❌ Cancel', 'cancel_sell')],
      ];
    } else {
      confirmMsg = userState.usePidgin
        ? `Step 3/5: Sell ${amount} ${asset} on ${networkInput.toUpperCase()}.\nNo bank dey o. We go link one now...`
        : `Step 3/5: Sell ${amount} ${asset} on ${networkInput.toUpperCase()}.\nNo bank linked. Linking one now...`;
      await ctx.reply(confirmMsg);
      return ctx.scene.enter('bank_linking_scene_temp');
    }

    await ctx.reply(confirmMsg, Markup.inlineKeyboard(keyboard));
    return ctx.wizard.next();
  },
  // Step 4: Handle bank choice and show summary with edit options
  async (ctx) => {
    const callbackData = ctx.callbackQuery?.data;
    const userState = await getUserState(ctx.wizard.state.data.userId);

    if (!callbackData) return;

    if (callbackData === 'cancel_sell') {
      await handleCancel(ctx);
      return ctx.scene.leave();
    } else if (callbackData === 'link_new_bank') {
      const prompt = userState.usePidgin
        ? 'Step 3/5: Linking new bank for this sell...'
        : 'Step 3/5: Linking a new bank for this sell...';
      await ctx.reply(prompt);
      return ctx.scene.enter('bank_linking_scene_temp');
    } else if (callbackData === 'use_existing_bank') {
      const userDoc = await db.collection('users').doc(ctx.wizard.state.data.userId).get();
      ctx.wizard.state.data.bankDetails = userDoc.data().wallets[0].bank;
    } else {
      return; // Wait for valid callback
    }

    await showSummary(ctx);
    return ctx.wizard.next();
  },
  // Step 5: Wallet confirmation with animated status
  async (ctx) => {
    const callbackData = ctx.callbackQuery?.data;
    const userState = await getUserState(ctx.wizard.state.data.userId);

    if (callbackData === 'cancel_sell') {
      await handleCancel(ctx);
      return ctx.scene.leave();
    }

    const baseMsg = userState.usePidgin
      ? 'Step 5/5: Waiting for wallet confirmation... Check your wallet app o'
      : 'Step 5/5: Waiting for wallet confirmation... Check your wallet app';
    const message = await ctx.reply(`${baseMsg}.`);
    let dots = 1;
    const interval = setInterval(async () => {
      dots = (dots % 3) + 1;
      await ctx.telegram
        .editMessageText(ctx.chat.id, message.message_id, null, `${baseMsg}${'.'.repeat(dots)}`)
        .catch(() => clearInterval(interval));
    }, 1000);

    // Store last sell data after successful initiation
    const { userId, asset, chainId } = ctx.wizard.state.data;
    await db.collection('users').doc(userId).update({
      lastSell: {
        asset,
        network: Object.keys(networkMap).find((key) => networkMap[key] === chainId),
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
      },
    });

    ctx.scene.leave().then(() => clearInterval(interval));
  }
);

// Helper: Show summary with edit options
async function showSummary(ctx) {
  const { userId, amount, asset, chainId, token, amountInWei, bankDetails } = ctx.wizard.state.data;
  const userState = await getUserState(userId);
  const networkName = Object.keys(networkMap).find((key) => networkMap[key] === chainId);

  // Generate Blockradar wallet (adapted from bot.js generateWallet)
  const blockradarAddress = await generateBlockradarAddress(bankDetails);
  const referenceId = `SELL-${uuidv4().replace(/-/g, '')}`;

  // Store session data (aligned with bot.js session structure)
  await db.collection('sessions').doc(referenceId).set({
    userId,
    amount: amountInWei,
    asset: token.address,
    chainId,
    bankDetails,
    blockradarAddress,
    status: 'pending',
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    symbol: token.symbol,
    tokenName: token.name,
    decimals: token.decimals,
    networkName,
  });

  const summaryMsg = userState.usePidgin
    ? `Step 4/5: Summary:\nSell: ${amount} ${asset} (${networkName.toUpperCase()})\nBank: ${bankDetails.bankName} - ****${bankDetails.accountNumber.slice(-4)}\nCorrect?`
    : `Step 4/5: Summary:\nSell: ${amount} ${asset} (${networkName.toUpperCase()})\nBank: ${bankDetails.bankName} - ****${bankDetails.accountNumber.slice(-4)}\nConfirm?`;

  await ctx.reply(summaryMsg, Markup.inlineKeyboard([
    [
      Markup.button.callback('✅ Yes', 'confirm_sell'),
      Markup.button.callback('❌ Cancel', 'cancel_sell'),
    ],
    [
      Markup.button.callback('Edit Amount', 'edit_amount'),
      Markup.button.callback('Edit Network', 'edit_network'),
    ],
    [Markup.button.callback('Edit Bank', 'edit_bank')],
  ]));

  ctx.wizard.state.data.referenceId = referenceId;
}

// Helper: Handle cancellation with feedback
async function handleCancel(ctx) {
  const userState = await getUserState(ctx.wizard.state.data.userId);
  const cancelMsg = userState.usePidgin
    ? 'Sell don cancel o. Why you stop?'
    : 'Sell cancelled. Why did you stop?';
  await ctx.reply(cancelMsg, Markup.inlineKeyboard([
    [
      Markup.button.callback('Change mind', 'reason_mind'),
      Markup.button.callback('Too complex', 'reason_complex'),
    ],
    [Markup.button.callback('Other', 'reason_other')],
  ]));
}

// Helper: Generate Blockradar address (adapted from bot.js generateWallet)
async function generateBlockradarAddress(bankDetails) {
  try {
    const chain = 'Base'; // Default to Base for Blockradar
    const chainData = {
      id: 'e31c44d6-0344-4ee1-bcd1-c88e89a9e3f1',
      key: process.env.BLOCKRADAR_BASE_API_KEY,
      apiUrl: 'https://api.blockradar.co/v1/wallets/e31c44d6-0344-4ee1-bcd1-c88e89a9e3f1/addresses',
      supportedAssets: ['USDC', 'USDT'],
      network: 'Base',
      chainId: 8453,
    };

    const response = await axios.post(
      chainData.apiUrl,
      { name: `DirectPay_Sell_Wallet_${bankDetails.accountNumber.slice(-4)}` },
      { headers: { 'x-api-key': chainData.key } }
    );

    const walletAddress = response.data.data.address;
    if (!walletAddress) throw new Error('Wallet address not returned from Blockradar.');
    logger.info(`Generated Blockradar wallet for bank ${bankDetails.bankName}: ${walletAddress}`);
    return walletAddress;
  } catch (error) {
    logger.error(`Error generating Blockradar wallet: ${error.message}`);
    return '0xGeneratedBlockradarAddress'; // Fallback dummy address
  }
}

// Action handlers
sellScene.action('retry_token', (ctx) => ctx.wizard.selectStep(2));
sellScene.action('edit_amount', async (ctx) => {
  const userState = await getUserState(ctx.wizard.state.data.userId);
  await ctx.reply(userState.usePidgin ? 'Enter new amount:' : 'Enter new amount:');
  return ctx.wizard.selectStep(1);
});
sellScene.action('edit_network', async (ctx) => {
  const userState = await getUserState(ctx.wizard.state.data.userId);
  await ctx.reply(userState.usePidgin ? 'Enter new network:' : 'Enter new network:');
  return ctx.wizard.selectStep(2);
});
sellScene.action('edit_bank', async (ctx) => {
  const userState = await getUserState(ctx.wizard.state.data.userId);
  await ctx.reply(userState.usePidgin ? 'Linking new bank...' : 'Linking a new bank...');
  return ctx.scene.enter('bank_linking_scene_temp');
});
sellScene.action('confirm_sell', async (ctx) => {
  const userState = await getUserState(ctx.wizard.state.data.userId);
  await ctx.reply(userState.usePidgin ? 'Step 4/5: Connecting wallet...' : 'Step 4/5: Connecting wallet...', {
    reply_markup: {
      inline_keyboard: [
        [
          Markup.button.url(
            'Connect Wallet',
            `${process.env.WEBAPP_URL}/connect?userId=${ctx.wizard.state.data.userId}&session=${ctx.wizard.state.data.referenceId}`
          ),
        ],
        [Markup.button.callback('❌ Cancel', 'cancel_sell')],
      ],
    },
  });
  return ctx.wizard.selectStep(4);
});
sellScene.action(/reason_.+/, async (ctx) => {
  const reason = ctx.callbackQuery.data.split('_')[1];
  logger.info(`User ${ctx.wizard.state.data.userId} cancelled sell due to: ${reason}`);
  await ctx.reply('Thanks for the feedback!');
});

// Handle return from bank_linking_scene_temp
sellScene.on('enter', async (ctx) => {
  if (ctx.scene.state.bankDetails) {
    ctx.wizard.state.data.bankDetails = ctx.scene.state.bankDetails;
    delete ctx.scene.state.bankDetails;
    if (ctx.wizard.state.data.amount && ctx.wizard.state.data.asset && ctx.wizard.state.data.chainId) {
      await showSummary(ctx);
      ctx.wizard.selectStep(4);
    }
  }
});

module.exports = {
  sellScene,
  setup: (botInstance) => {
    botInstance.command('sell', (ctx) => ctx.scene.enter('sell_scene'));
  },
};
