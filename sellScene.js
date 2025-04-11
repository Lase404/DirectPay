const { Scenes, Markup } = require('telegraf');
const axios = require('axios');
const admin = require('firebase-admin');
const winston = require('winston');

// Logger setup (assuming it's global or imported)
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => `[${timestamp}] ${level.toUpperCase()}: ${message}`)
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'bot.log', maxsize: 5242880, maxFiles: 5 }),
  ],
});

// Firebase setup (assuming db is initialized globally)
const db = admin.firestore();

// External dependencies (assuming these are defined elsewhere)
const networkMap = {
  'base': 8453,
  'polygon': 137,
  'bnb': 56,
};

const chains = {
  base: { chainId: 8453, name: 'Base' },
  polygon: { chainId: 137, name: 'Polygon' },
  bnb: { chainId: 56, name: 'BNB Chain' },
};

// Placeholder for getUserState (assuming it's imported or global)
async function getUserState(userId) {
  try {
    const userDoc = await db.collection('users').doc(userId).get();
    if (!userDoc.exists) {
      const defaultState = { wallets: [], bankDetails: null, usePidgin: false };
      await db.collection('users').doc(userId).set(defaultState);
      logger.info(`Initialized user state for ${userId}`);
      return defaultState;
    }
    const data = userDoc.data();
    return {
      wallets: data.wallets || [],
      bankDetails: data.bankDetails || null,
      usePidgin: data.usePidgin || false,
    };
  } catch (error) {
    logger.error(`Failed to fetch user state for ${userId}: ${error.message}`);
    return { wallets: [], bankDetails: null, usePidgin: false };
  }
}

// Placeholder for generateReferenceId
function generateReferenceId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

// Sell Scene
const sellScene = new Scenes.WizardScene(
  'sell_scene',
  // Step 1: Validate /sell input and token
  async (ctx) => {
    const userId = ctx.from.id.toString();
    logger.info(`User ${userId} entered sell_scene with: ${ctx.message.text}`);

    // Ensure command is /sell
    if (!ctx.message.text.startsWith('/sell ')) {
      const userState = await getUserState(userId);
      const usage = userState.usePidgin
        ? 'Usage: /sell <amount> <currency or address> <network>\nE.g., /sell 10 USDC base or /sell 10 0x833589f... base'
        : 'Usage: /sell <amount> <currency or address> <network>\nExample: /sell 10 USDC base or /sell 10 0x833589f... base';
      try {
        await ctx.replyWithMarkdown(usage);
      } catch (error) {
        logger.error(`Failed to send usage message for user ${userId}: ${error.message}`);
      }
      return ctx.scene.leave();
    }

    const userState = await getUserState(userId);
    const args = ctx.message.text.split(' ').filter(arg => arg.trim() !== '');
    if (args.length !== 4) {
      const usage = userState.usePidgin
        ? 'Usage: /sell <amount> <currency or address> <network>\nE.g., /sell 10 USDC base or /sell 10 0x833589f... base'
        : 'Usage: /sell <amount> <currency or address> <network>\nExample: /sell 10 USDC base or /sell 10 0x833589f... base';
      try {
        await ctx.replyWithMarkdown(usage);
      } catch (error) {
        logger.error(`Failed to send usage message for user ${userId}: ${error.message}`);
      }
      return ctx.scene.leave();
    }

    const [_, amountStr, caOrTerm, network] = args;
    const amount = parseFloat(amountStr);

    if (!amount || isNaN(amount) || amount <= 0 || !caOrTerm || !network) {
      const error = userState.usePidgin
        ? '❌ Amount, currency, or network no correct o. Try again.'
        : '❌ Invalid amount, currency, or network. Please try again.';
      try {
        await ctx.replyWithMarkdown(error);
      } catch (error) {
        logger.error(`Failed to send error message for user ${userId}: ${error.message}`);
      }
      return ctx.scene.leave();
    }

    const chainId = networkMap[network.toLowerCase()];
    if (!chainId || !Object.values(chains).some(c => c.chainId === chainId)) {
      const error = userState.usePidgin
        ? 'Network no dey o. We support: base, polygon, bnb'
        : 'Invalid network. Supported: base, polygon, bnb';
      try {
        await ctx.replyWithMarkdown(error);
      } catch (error) {
        logger.error(`Failed to send network error for user ${userId}: ${error.message}`);
      }
      return ctx.scene.leave();
    }

    const isAddress = /^0x[a-fA-F0-9]{40}$/.test(caOrTerm);
    const payload = isAddress
      ? { chainIds: [chainId], address: caOrTerm.toLowerCase(), verified: true, limit: 123, includeAllChains: true, useExternalSearch: true, depositAddressOnly: true }
      : { chainIds: [chainId], term: caOrTerm.toLowerCase(), verified: true, limit: 123, includeAllChains: true, useExternalSearch: true, depositAddressOnly: true };

    let currencyRes;
    try {
      currencyRes = await axios.post('https://api.relay.link/currencies/v1', payload, { timeout: 5000 });
      logger.info(`Relay API response for user ${userId}: ${JSON.stringify(currencyRes.data)}`);
    } catch (err) {
      logger.error(`Relay currency validation failed for ${caOrTerm} on ${network}: ${err.message}`);
      const error = userState.usePidgin
        ? '❌ Wahala dey o. Currency or address check fail. Try again.'
        : '❌ Error validating currency or address. Please try again.';
      try {
        await ctx.replyWithMarkdown(error);
      } catch (error) {
        logger.error(`Failed to send Relay error for user ${userId}: ${error.message}`);
      }
      return ctx.scene.leave();
    }

    if (!currencyRes.data?.[0]?.length || currencyRes.data[0][0].chainId !== chainId) {
      const error = userState.usePidgin
        ? `❌ ${caOrTerm} no dey for ${network}. Check am well o.`
        : `❌ ${caOrTerm} not found or invalid on ${network}. Please check your input.`;
      try {
        await ctx.replyWithMarkdown(error);
      } catch (error) {
        logger.error(`Failed to send token error for user ${userId}: ${error.message}`);
      }
      return ctx.scene.leave();
    }

    const currencyData = currencyRes.data[0][0];
    const decimals = currencyData.decimals;
    const amountInWei = (amount * Math.pow(10, decimals)).toString();
    ctx.wizard.state.data = {
      userId,
      amount,
      amountInWei,
      ca: currencyData.symbol,
      chainId,
      originCurrency: currencyData.address,
      decimals,
      network: network.toLowerCase(),
    };
    logger.info(`User ${userId} set wizard state: ${JSON.stringify(ctx.wizard.state.data)}`);

    const confirm = userState.usePidgin
      ? `You wan sell ${amount} ${currencyData.symbol} on ${network}?\n*Click* "Yes" to go ahead or "No" to stop.`
      : `Sell ${amount} ${currencyData.symbol} on ${network}?\n*Click* "Yes" to confirm or "No" to cancel.`;
    try {
      await ctx.replyWithMarkdown(confirm, {
        ...Markup.inlineKeyboard([
          Markup.button.callback('✅ Yes', 'yes'),
          Markup.button.callback('❌ No', 'no'),
        ]),
        reply_markup: Markup.removeKeyboard().reply_markup, // Hide keyboard to discourage typing
      });
      logger.info(`User ${userId} prompted for confirmation`);
      return ctx.wizard.next();
    } catch (error) {
      logger.error(`Failed to send confirmation for user ${userId}: ${error.message}`);
      try {
        await ctx.reply('Error sending confirmation. Try again.');
      } catch (err) {
        logger.error(`Failed to send fallback message for user ${userId}: ${err.message}`);
      }
      return ctx.scene.leave();
    }
  },
  // Step 2: Bank Selection
  async (ctx) => {
    const userId = ctx.from?.id.toString() || ctx.wizard.state.data?.userId;
    logger.info(`User ${userId} at step 2, wizard state: ${JSON.stringify(ctx.wizard.state.data)}`);
    logger.info(`Current wizard step: ${ctx.wizard.cursor}`);

    // Validate wizard state
    if (!ctx.wizard.state.data?.userId || !ctx.wizard.state.data?.amount || !ctx.wizard.state.data?.ca) {
      logger.error(`Invalid wizard state for user ${userId}: ${JSON.stringify(ctx.wizard.state.data)}`);
      try {
        await ctx.reply('Session expired or invalid. Please start over with /sell.');
      } catch (error) {
        logger.error(`Failed to send state error for user ${userId}: ${error.message}`);
      }
      return ctx.scene.leave();
    }

    // Handle typed inputs (e.g., "yes")
    if (!ctx.callbackQuery && ctx.message?.text) {
      const userState = await getUserState(userId);
      const msg = userState.usePidgin
        ? 'Oga, *click* di "Yes" or "No" button wey I send o!'
        : 'Please *click* the "Yes" or "No" button I sent!';
      try {
        await ctx.replyWithMarkdown(msg);
      } catch (error) {
        logger.error(`Failed to send typed input prompt for user ${userId}: ${error.message}`);
      }
      return; // Stay in step 2
    }

    const action = ctx.callbackQuery?.data;
    if (!action) {
      logger.warn(`No callbackQuery for user ${userId} in step 2`);
      try {
        await ctx.reply('Please confirm or cancel the token selection.');
      } catch (error) {
        logger.error(`Failed to send no-callback prompt for user ${userId}: ${error.message}`);
      }
      return ctx.scene.leave();
    }

    const userState = await getUserState(ctx.wizard.state.data.userId);
    if (action === 'no') {
      try {
        await ctx.editMessageText(
          userState.usePidgin ? 'Sell don cancel. Need help? Chat us or try /sell again.' : 'Sell cancelled. Need help? Contact us or retry with /sell.',
          { parse_mode: 'Markdown' }
        );
        await ctx.answerCbQuery();
        logger.info(`User ${userId} cancelled sell`);
        return ctx.scene.leave();
      } catch (error) {
        logger.error(`Failed to edit cancel message for user ${userId}: ${error.message}`);
        try {
          await ctx.reply('Sell cancelled.');
        } catch (err) {
          logger.error(`Failed to send fallback cancel message for user ${userId}: ${err.message}`);
        }
        return ctx.scene.leave();
      }
    }

    if (action !== 'yes') {
      logger.warn(`Unexpected callback ${action} for user ${userId}`);
      try {
        await ctx.reply('Unexpected action. Use /sell to start over.');
      } catch (error) {
        logger.error(`Failed to send unexpected action message for user ${userId}: ${error.message}`);
      }
      await ctx.answerCbQuery();
      return ctx.scene.leave();
    }

    const userWallets = userState.wallets;
    const linkedBank = userWallets.find(w => w.bank)?.bank;

    const prompt = linkedBank
      ? userState.usePidgin
        ? `Use your bank wey dey already (${linkedBank.bankName} - ****${linkedBank.accountNumber.slice(-4)}) or add new one?`
        : `Use existing bank (${linkedBank.bankName} - ****${linkedBank.accountNumber.slice(-4)}) or link a new one?`
      : userState.usePidgin
        ? 'No bank dey o. Add one for this sell?'
        : 'No bank linked. Link a new one for this sell?';

    try {
      await ctx.editMessageText(prompt, {
        parse_mode: 'Markdown',
        reply_markup: Markup.inlineKeyboard([
          linkedBank ? Markup.button.callback('✅ Use Existing', 'use_existing') : null,
          Markup.button.callback('🏦 Link New', 'link_new'),
        ].filter(Boolean)).reply_markup,
      });
      await ctx.answerCbQuery();
      logger.info(`User ${userId} shown bank options`);
      return ctx.wizard.next();
    } catch (error) {
      logger.error(`Failed to edit bank prompt for user ${userId}: ${error.message}`);
      try {
        await ctx.reply('Error showing bank options. Try again.');
      } catch (err) {
        logger.error(`Failed to send fallback bank error for user ${userId}: ${err.message}`);
      }
      return ctx.scene.leave();
    }
  },
  // Step 3: Finalize Transaction and Privy Wallet Connection
  async (ctx) => {
    const userId = ctx.from?.id.toString() || ctx.wizard.state.data?.userId;
    logger.info(`User ${userId} at step 3, wizard state: ${JSON.stringify(ctx.wizard.state.data)}`);
    logger.info(`Current wizard step: ${ctx.wizard.cursor}`);

    // Validate wizard state
    if (!ctx.wizard.state.data?.userId || !ctx.wizard.state.data?.amount || !ctx.wizard.state.data?.ca) {
      logger.error(`Invalid wizard state for user ${userId}: ${JSON.stringify(ctx.wizard.state.data)}`);
      try {
        await ctx.reply('Session expired or invalid. Please start over with /sell.');
      } catch (error) {
        logger.error(`Failed to send state error for user ${userId}: ${error.message}`);
      }
      return ctx.scene.leave();
    }

    // Handle typed inputs
    if (!ctx.callbackQuery && ctx.message?.text) {
      const userState = await getUserState(userId);
      const msg = userState.usePidgin
        ? 'Oga, *click* di "Use Existing" or "Link New" button o!'
        : 'Please *click* the "Use Existing" or "Link New" button!';
      try {
        await ctx.replyWithMarkdown(msg);
      } catch (error) {
        logger.error(`Failed to send typed input prompt for user ${userId}: ${error.message}`);
      }
      return; // Stay in step 3
    }

    const action = ctx.callbackQuery?.data;
    if (!action) {
      logger.warn(`No callbackQuery for user ${userId} in step 3`);
      try {
        await ctx.reply('Please select a bank option.');
      } catch (error) {
        logger.error(`Failed to send no-callback prompt for user ${userId}: ${error.message}`);
      }
      return ctx.scene.leave();
    }

    const userState = await getUserState(userId);
    let blockradarAddress;

    if (action === 'use_existing') {
      const wallet = userState.wallets.find(w => w.bank);
      if (wallet) {
        ctx.wizard.state.data.bankDetails = wallet.bank;
        blockradarAddress = wallet.address;
      }
    } else if (action === 'link_new') {
      logger.info(`User ${userId} chose to link new bank`);
      try {
        await ctx.answerCbQuery();
      } catch (error) {
        logger.error(`Failed to answer callback for user ${userId}: ${error.message}`);
      }
      ctx.wizard.state.tempBank = true;
      return ctx.scene.enter('bank_linking_scene_temp', { sellData: ctx.wizard.state.data });
    } else {
      logger.warn(`Unexpected callback ${action} for user ${userId}`);
      try {
        await ctx.reply('Unexpected action. Use /sell to start over.');
      } catch (error) {
        logger.error(`Failed to send unexpected action message for user ${userId}: ${error.message}`);
      }
      try {
        await ctx.answerCbQuery();
      } catch (error) {
        logger.error(`Failed to answer callback for user ${userId}: ${error.message}`);
      }
      return ctx.scene.leave();
    }

    // Handle return from bank linking
    if (ctx.wizard.state.tempBank && ctx.scene.session.bankDetails) {
      ctx.wizard.state.data.bankDetails = ctx.scene.session.bankDetails;
      blockradarAddress = ctx.scene.session.bankDetails.relayAddress;
      delete ctx.scene.session.bankDetails;
      delete ctx.wizard.state.tempBank;
    }

    if (!blockradarAddress) {
      const error = userState.usePidgin ? 'Bank no set o. Try again.' : 'Bank selection incomplete. Please retry.';
      try {
        await ctx.replyWithMarkdown(error);
      } catch (error) {
        logger.error(`Failed to send bank error for user ${userId}: ${error.message}`);
      }
      return ctx.scene.leave();
    }

    ctx.wizard.state.data.recipient = blockradarAddress;

    const referenceId = generateReferenceId();
    try {
      await db.collection('transactions').doc(referenceId).set({
        userId,
        bankDetails: ctx.wizard.state.data.bankDetails,
        blockradarAddress,
        status: 'pending',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        amount: ctx.wizard.state.data.amount,
        asset: ctx.wizard.state.data.ca,
        chain: Object.keys(chains).find(key => chains[key].chainId === ctx.wizard.state.data.chainId),
        referenceId,
      });
      logger.info(`Transaction created for user ${userId}: ${referenceId}`);
    } catch (error) {
      logger.error(`Failed to save transaction for user ${userId}: ${error.message}`);
      try {
        await ctx.reply('Error saving transaction. Try again.');
      } catch (err) {
        logger.error(`Failed to send transaction error for user ${userId}: ${err.message}`);
      }
      return ctx.scene.leave();
    }

    // Privy wallet connection
    const privyConnectUrl = `${process.env.WEBAPP_URL}/connect?userId=${userId}&referenceId=${referenceId}`;
    const msg = userState.usePidgin
      ? `Transaction don set! *Click* di button to connect your wallet with Privy o.`
      : `Transaction created! *Click* the button to connect your wallet with Privy.`;
    try {
      await ctx.editMessageText(msg, {
        parse_mode: 'Markdown',
        reply_markup: Markup.inlineKeyboard([
          Markup.button.url('Connect Wallet', privyConnectUrl),
          Markup.button.callback('❌ Cancel', 'cancel'),
        ]).reply_markup,
      });
      await ctx.answerCbQuery();
      logger.info(`User ${userId} prompted for Privy wallet connection: ${referenceId}`);
      return ctx.scene.leave();
    } catch (error) {
      logger.error(`Failed to prompt Privy connect for user ${userId}: ${error.message}`);
      try {
        await ctx.reply('Error connecting wallet. Try again.');
      } catch (err) {
        logger.error(`Failed to send Privy error for user ${userId}: ${err.message}`);
      }
      return ctx.scene.leave();
    }
  }
);

// Action Handlers
sellScene.action('yes', async (ctx) => {
  const userId = ctx.from.id.toString();
  logger.info(`User ${userId} confirmed token`);
  try {
    await ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Failed to answer yes callback for user ${userId}: ${error.message}`);
  }
  // No ctx.wizard.next(); step 1 handles advancement
});

sellScene.action('no', async (ctx) => {
  const userId = ctx.from.id.toString();
  logger.info(`User ${userId} cancelled sell`);
  const userState = await getUserState(userId);
  try {
    await ctx.editMessageText(userState.usePidgin ? 'Sell don cancel.' : 'Sell cancelled.', { parse_mode: 'Markdown' });
    await ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Failed to handle no action for user ${userId}: ${error.message}`);
    try {
      await ctx.reply('Sell cancelled.');
    } catch (err) {
      logger.error(`Failed to send fallback cancel message for user ${userId}: ${err.message}`);
    }
  }
  return ctx.scene.leave();
});

sellScene.action('use_existing', async (ctx) => {
  const userId = ctx.from.id.toString();
  logger.info(`User ${userId} selected existing bank`);
  try {
    await ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Failed to answer use_existing callback for user ${userId}: ${error.message}`);
  }
  return ctx.wizard.next();
});

sellScene.action('link_new', async (ctx) => {
  const userId = ctx.from.id.toString();
  logger.info(`User ${userId} chose new bank`);
  try {
    await ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Failed to answer link_new callback for user ${userId}: ${error.message}`);
  }
  return ctx.scene.enter('bank_linking_scene_temp', { sellData: ctx.wizard.state.data });
});

sellScene.action('cancel', async (ctx) => {
  const userId = ctx.from.id.toString();
  logger.info(`User ${userId} cancelled sell`);
  const userState = await getUserState(userId);
  try {
    await ctx.editMessageText(userState.usePidgin ? 'Sell don cancel.' : 'Sell cancelled.', { parse_mode: 'Markdown' });
    await ctx.answerCbQuery();
  } catch (error) {
    logger.error(`Failed to handle cancel action for user ${userId}: ${error.message}`);
    try {
      await ctx.reply('Sell cancelled.');
    } catch (err) {
      logger.error(`Failed to send fallback cancel message for user ${userId}: ${err.message}`);
    }
  }
  return ctx.scene.leave();
});

// Handle return from bank linking
sellScene.enter(async (ctx) => {
  const userId = ctx.from?.id.toString();
  if (ctx.scene.state.sellData && ctx.scene.session.bankDetails) {
    logger.info(`User ${userId} returned from bank linking`);
    ctx.wizard.state.data = ctx.scene.state.sellData;
    ctx.wizard.state.tempBank = true;
    ctx.wizard.cursor = 2; // Resume at step 3
    try {
      return await ctx.wizard.steps[ctx.wizard.cursor](ctx);
    } catch (error) {
      logger.error(`Failed to resume sell_scene for user ${userId}: ${error.message}`);
      try {
        await ctx.reply('Error resuming transaction. Please start over with /sell.');
      } catch (err) {
        logger.error(`Failed to send resume error for user ${userId}: ${err.message}`);
      }
      return ctx.scene.leave();
    }
  }
});

// Export
module.exports = {
  sellScene,
  setup: () => {},
};
