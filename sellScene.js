const { Scenes, Markup } = require('telegraf');
const axios = require('axios');
const ethers = require('ethers');
const { v4: uuidv4 } = require('uuid');
const qs = require('querystring');

const sellScene = new Scenes.WizardScene(
  'sell_scene',
  // **Step 0: Parse and Validate Input**
  async (ctx) => {
    const userId = ctx.from.id.toString();
    ctx.wizard.state.userId = userId;

    let userState;
    try {
      userState = await sellScene.getUserState(userId);
      if (!userState) throw new Error('User state not found');
    } catch (err) {
      sellScene.logger.error(`Failed to fetch user state for user ${userId}: ${err.message}`);
      await ctx.replyWithMarkdown(
        '❌ Error fetching your profile. Please try again or contact [@maxcswap](https://t.me/maxcswap).',
        Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]])
      );
      return ctx.scene.leave();
    }

    sellScene.logger.info(`User ${userId} entered sell scene with input: ${ctx.message?.text || 'unknown'}`);

    const input = ctx.message?.text?.replace('/sell', '').trim().split(/\s+/);
    if (!input || input.length < 3) {
      const errorMsg = userState.usePidgin
        ? '❌ Format no correct. Use: /sell <amount> <asset/address> <chain>\nE.g., /sell 100 USDC eth'
        : '❌ Invalid format. Use: /sell <amount> <asset/address> <chain>\nE.g., /sell 100 USDC eth';
      await ctx.replyWithMarkdown(
        errorMsg,
        Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]])
      );
      return ctx.scene.leave();
    }

    const [amountStr, assetInput, chain] = input;
    const amount = parseFloat(amountStr);
    if (isNaN(amount) || amount <= 0) {
      const errorMsg = userState.usePidgin
        ? '❌ Amount no valid. Enter correct number like 100 or 0.5.'
        : '❌ Invalid amount. Please enter a valid number like 100 or 0.5.';
      await ctx.replyWithMarkdown(
        errorMsg,
        Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]])
      );
      return ctx.scene.leave();
    }

    ctx.wizard.state = {
      userId,
      amount,
      assetInput,
      chain: chain.toLowerCase(),
      stepStartedAt: Date.now(),
    };

    await ctx.replyWithMarkdown(
      userState.usePidgin
        ? '🔄 Dey check your asset and chain... E fit take small time.'
        : '🔄 Verifying your asset and chain... This may take a moment.'
    );

    try {
      const chainId = mapChainToId(ctx.wizard.state.chain);
      if (!chainId) {
        throw new Error(`Unsupported chain: ${ctx.wizard.state.chain}. Supported: eth, base, bnb, polygon`);
      }

      let assets;
      if (ethers.utils.isAddress(assetInput)) {
        assets = await validateAssetByAddress(assetInput, chainId, sellScene.relayClient);
      } else {
        assets = await validateAssetByTerm(assetInput, chainId, sellScene.relayClient);
      }

      if (!assets || assets.length === 0) {
        const errorMsg = userState.usePidgin
          ? '❌ No asset match your input for this chain. Check the symbol or address and try again.'
          : '❌ No matching assets found for this chain. Verify the symbol or address and try again.';
        await ctx.replyWithMarkdown(
          errorMsg,
          Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]])
        );
        return ctx.scene.leave();
      }

      ctx.wizard.state.validatedAssets = assets;
      if (assets.length > 1) {
        const options = assets.map((asset, index) => [
          Markup.button.callback(
            `${asset.symbol} - ${asset.name} (${asset.address.slice(0, 6)}...)`,
            `select_asset_${index}`
          ),
        ]);
        options.push([Markup.button.callback('❌ Cancel', 'cancel_sell')]);
        await ctx.replyWithMarkdown(
          userState.usePidgin
            ? '🤔 Multiple assets dey. Pick the one you want (Step 1/4):'
            : '🤔 Multiple assets found. Please select one (Step 1/4):',
          Markup.inlineKeyboard(options)
        );
        sellScene.logger.info(`User ${userId} prompted to select asset from ${assets.length} options`);
        return;
      } else {
        ctx.wizard.state.selectedAsset = assets[0];
        sellScene.logger.info(`User ${userId} auto-selected single asset: ${assets[0].symbol}`);
        await promptBankSelection(ctx);
        return;
      }
    } catch (error) {
      sellScene.logger.error(`Error validating asset for user ${userId}: ${error.message}`);
      const errorMsg = userState.usePidgin
        ? `❌ Error checking asset: ${error.message}. Try again or contact [@maxcswap](https://t.me/maxcswap).`
        : `❌ Error verifying asset: ${error.message}. Try again or contact [@maxcswap](https://t.me/maxcswap).`;
      await ctx.replyWithMarkdown(
        errorMsg,
        Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]])
      );
      return ctx.scene.leave();
    }
  },
  // **Step 1: Handle Unexpected Messages**
  async (ctx) => {
    await ctx.replyWithMarkdown('Please use the buttons to proceed.');
    return;
  }
);

// **Helper Functions**

function mapChainToId(chain) {
  const chainMap = {
    eth: 1,
    ethereum: 1,
    base: 8453,
    bnb: 56,
    bsc: 56,
    polygon: 137,
    matic: 137,
  };
  return chainMap[chain.toLowerCase()];
}

async function validateAssetByAddress(address, chainId, relayClient, retries = 2) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      sellScene.logger.info(`Validating asset by address: ${address} on chainId: ${chainId}, attempt ${attempt}`);
      const response = await axios.post(
        'https://api.relay.link/currencies/v1',
        {
          chainIds: [chainId],
          term: address,
          verified: true,
          limit: 10,
          includeAllChains: false,
          useExternalSearch: true,
          depositAddressOnly: true,
        },
        { headers: { 'Content-Type': 'application/json' } }
      );
      return response.data.flat();
    } catch (error) {
      sellScene.logger.error(`Address validation failed for address ${address}, attempt ${attempt}: ${error.message}`);
      if (attempt === retries) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
}

async function validateAssetByTerm(term, chainId, relayClient, retries = 2) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      sellScene.logger.info(`Validating asset by term: ${term} on chainId: ${chainId}, attempt ${attempt}`);
      const response = await axios.post(
        'https://api.relay.link/currencies/v1',
        {
          chainIds: [chainId],
          term,
          verified: true,
          limit: 10,
          includeAllChains: false,
          useExternalSearch: true,
          depositAddressOnly: true,
        },
        { headers: { 'Content-Type': 'application/json' } }
      );
      return response.data.flat();
    } catch (error) {
      sellScene.logger.error(`Term validation failed for term ${term}, attempt ${attempt}: ${error.message}`);
      if (attempt === retries) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
}

async function promptBankSelection(ctx) {
  const userId = ctx.wizard.state.userId;
  let userState;
  try {
    userState = await sellScene.getUserState(userId);
    if (!userState) throw new Error('User state not found');
  } catch (err) {
    sellScene.logger.error(`Failed to fetch user state for user ${userId}: ${err.message}`);
    await ctx.replyWithMarkdown(
      '❌ Error fetching your profile. Please try again or contact [@maxcswap](https://t.me/maxcswap).',
      Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]])
    );
    return ctx.scene.leave();
  }

  const walletsWithBank = userState.wallets?.filter((w) => w.bank) || [];
  const asset = ctx.wizard.state.selectedAsset;

  if (!asset) {
    await ctx.replyWithMarkdown(
      userState.usePidgin
        ? '❌ No asset selected. Start again with /sell.'
        : '❌ No asset selected. Please start over with /sell.',
      Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]])
    );
    return ctx.scene.leave();
  }

  if (walletsWithBank.length === 0) {
    const prompt = userState.usePidgin
      ? '🏦 No bank linked yet. You wan link one for this sell? (Step 2/4)'
      : '🏦 No bank linked yet. Would you like to link one for this sell? (Step 2/4)';
    await ctx.replyWithMarkdown(
      prompt,
      Markup.inlineKeyboard([
        [Markup.button.callback('✅ Yes', 'link_temp_bank')],
        [Markup.button.callback('❌ Cancel', 'cancel_sell')],
      ])
    );
    sellScene.logger.info(`User ${userId} prompted to link bank (no banks linked)`);
  } else {
    const bankOptions = walletsWithBank.map((wallet, index) => [
      Markup.button.callback(
        `${wallet.bank.bankName} (****${wallet.bank.accountNumber.slice(-4)})`,
        `select_bank_${index}`
      ),
    ]);
    bankOptions.push([Markup.button.callback('➕ Use Another Bank', 'link_temp_bank')]);
    bankOptions.push([Markup.button.callback('❌ Cancel', 'cancel_sell')]);

    const assetMsg = userState.usePidgin
      ? `✅ *Asset Confirmed* (Step 2/4)\n\n` +
        `*Symbol:* ${asset.symbol}\n` +
        `*Name:* ${asset.name}\n` +
        `*Address:* \`${asset.address}\`\n` +
        `*Chain:* ${ctx.wizard.state.chain}\n` +
        `*Amount:* ${ctx.wizard.state.amount} ${asset.symbol}\n\n` +
        `Where you want the funds go?`
      : `✅ *Asset Confirmed* (Step 2/4)\n\n` +
        `*Symbol:* ${asset.symbol}\n` +
        `*Name:* ${asset.name}\n` +
        `*Address:* \`${asset.address}\`\n` +
        `*Chain:* ${ctx.wizard.state.chain}\n` +
        `*Amount:* ${ctx.wizard.state.amount} ${asset.symbol}\n\n` +
        `Where would you like to receive the funds?`;
    await ctx.replyWithMarkdown(assetMsg, Markup.inlineKeyboard(bankOptions));
    sellScene.logger.info(`User ${userId} prompted to select bank from ${walletsWithBank.length} options`);
  }
}

// **Action Handlers**

sellScene.action(/select_asset_(\d+)/, async (ctx) => {
  const userId = ctx.wizard.state.userId;
  let userState;
  try {
    userState = await sellScene.getUserState(userId);
    if (!userState) throw new Error('User state not found');
  } catch (err) {
    sellScene.logger.error(`Failed to fetch user state for user ${userId}: ${err.message}`);
    await ctx.replyWithMarkdown(
      '❌ Error fetching your profile. Please try again or contact [@maxcswap](https://t.me/maxcswap).',
      Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]])
    );
    await ctx.answerCbQuery();
    return ctx.scene.leave();
  }

  const index = parseInt(ctx.match[1], 10);
  const assets = ctx.wizard.state.validatedAssets;
  if (!assets || index < 0 || index >= assets.length) {
    await ctx.replyWithMarkdown(
      userState.usePidgin
        ? '❌ Asset no valid. Pick again or cancel.'
        : '❌ Invalid asset selection. Try again or cancel.',
      Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'cancel_sell')]])
    );
    await ctx.answerCbQuery();
    return;
  }

  ctx.wizard.state.selectedAsset = assets[index];
  await ctx.answerCbQuery();
  await ctx.replyWithMarkdown(
    userState.usePidgin
      ? `✅ Asset selected: ${assets[index].symbol}!`
      : `✅ Asset selected: ${assets[index].symbol}!`
  );
  sellScene.logger.info(`User ${userId} selected asset: ${assets[index].symbol}`);
  await promptBankSelection(ctx);
});

sellScene.action(/select_bank_(\d+)/, async (ctx) => {
  const userId = ctx.wizard.state.userId;
  let userState;
  try {
    userState = await sellScene.getUserState(userId);
    if (!userState) throw new Error('User state not found');
  } catch (err) {
    sellScene.logger.error(`Failed to fetch user state for user ${userId}: ${err.message}`);
    await ctx.replyWithMarkdown(
      '❌ Error fetching your profile. Please try again or contact [@maxcswap](https://t.me/maxcswap).',
      Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]])
    );
    await ctx.answerCbQuery();
    return ctx.scene.leave();
  }

  const index = parseInt(ctx.match[1], 10);
  const walletsWithBank = userState.wallets?.filter((w) => w.bank) || [];
  if (index < 0 || index >= walletsWithBank.length) {
    await ctx.replyWithMarkdown(
      userState.usePidgin
        ? '❌ Bank no valid. Pick again or cancel.'
        : '❌ Invalid bank selection. Try again or cancel.',
      Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'cancel_sell')]])
    );
    await ctx.answerCbQuery();
    return;
  }

  ctx.wizard.state.bankDetails = walletsWithBank[index].bank;
  ctx.wizard.state.selectedWalletAddress = walletsWithBank[index].address;

  const confirmMsg = userState.usePidgin
    ? `🏦 Funds go enter:\n` +
      `*Bank:* ${ctx.wizard.state.bankDetails.bankName}\n` +
      `*Account:* ****${ctx.wizard.state.bankDetails.accountNumber.slice(-4)}\n` +
      `*Name:* ${ctx.wizard.state.bankDetails.accountName}\n\n` +
      `E correct? (Step 3/4)`
    : `🏦 Funds will be sent to:\n` +
      `*Bank:* ${ctx.wizard.state.bankDetails.bankName}\n` +
      `*Account:* ****${ctx.wizard.state.bankDetails.accountNumber.slice(-4)}\n` +
      `*Name:* ${ctx.wizard.state.bankDetails.accountName}\n\n` +
      `Is this correct? (Step 3/4)`;
  await ctx.replyWithMarkdown(
    confirmMsg,
    Markup.inlineKeyboard([
      [Markup.button.callback('✅ Yes', 'confirm_bank')],
      [Markup.button.callback('❌ Cancel', 'cancel_sell')],
    ])
  );
  await ctx.answerCbQuery();
  sellScene.logger.info(`User ${userId} selected bank, awaiting confirmation`);
});

sellScene.action('confirm_bank', async (ctx) => {
  const userId = ctx.wizard.state.userId;
  let userState;
  try {
    userState = await sellScene.getUserState(userId);
    if (!userState) throw new Error('User state not found');
  } catch (err) {
    sellScene.logger.error(`Failed to fetch user state for user ${userId}: ${err.message}`);
    await ctx.replyWithMarkdown(
      '❌ Error fetching your profile. Please try again or contact [@maxcswap](https://t.me/maxcswap).',
      Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]])
    );
    await ctx.answerCbQuery();
    return ctx.scene.leave();
  }

  const { selectedAsset: asset, bankDetails, selectedWalletAddress, amount } = ctx.wizard.state;
  if (!asset || !bankDetails || !selectedWalletAddress || !amount) {
    sellScene.logger.error(`Missing details for user ${userId}: asset=${!!asset}, bankDetails=${!!bankDetails}, walletAddress=${!!selectedWalletAddress}, amount=${!!amount}`);
    const errorMsg = userState.usePidgin
      ? '❌ Something miss for your sell. Start again with /sell.'
      : '❌ Missing details for your sell. Please start over with /sell.';
    await ctx.replyWithMarkdown(
      errorMsg,
      Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]])
    );
    await ctx.answerCbQuery();
    return ctx.scene.leave();
  }

  let amountInWei;
  try {
    amountInWei = ethers.utils.parseUnits(amount.toString(), asset.decimals).toString();
  } catch (error) {
    sellScene.logger.error(`Error parsing amount for user ${userId}: ${error.message}`);
    const errorMsg = userState.usePidgin
      ? '❌ Amount no valid for this asset. Start again with /sell.'
      : '❌ Invalid amount for this asset. Please start over with /sell.';
    await ctx.replyWithMarkdown(
      errorMsg,
      Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]])
    );
    await ctx.answerCbQuery();
    return ctx.scene.leave();
  }

  ctx.wizard.state.amountInWei = amountInWei;
  ctx.wizard.state.sessionId = uuidv4();

  // Store session in database for completion tracking
  const sessionData = {
    userId,
    amountInWei,
    token: asset.address,
    chainId: mapChainToId(ctx.wizard.state.chain),
    bankDetails,
    blockradarWallet: selectedWalletAddress,
    status: 'pending',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
  };

  try {
    await sellScene.db.collection('sessions').doc(ctx.wizard.state.sessionId).set(sessionData);
    sellScene.logger.info(`Session stored for user ${userId}, sessionId: ${ctx.wizard.state.sessionId}`);
  } catch (error) {
    sellScene.logger.error(`Failed to store session for user ${userId}: ${error.message}`);
    const errorMsg = userState.usePidgin
      ? '❌ Error saving your sell details. Try again or contact [@maxcswap](https://t.me/maxcswap).'
      : '❌ Error saving your sell details. Try again or contact [@maxcswap](https://t.me/maxcswap).';
    await ctx.replyWithMarkdown(
      errorMsg,
      Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]])
    );
    await ctx.answerCbQuery();
    return ctx.scene.leave();
  }

  // Encode session data in URL query parameters
  const queryParams = {
    sessionId: ctx.wizard.state.sessionId,
    amountInWei,
    token: asset.address,
    chainId: mapChainToId(ctx.wizard.state.chain).toString(),
    blockradarWallet: selectedWalletAddress,
    bankName: bankDetails.bankName,
    accountNumber: bankDetails.accountNumber.slice(-4), // Only last 4 digits for security
  };
  const webhookDomain = sellScene.webhookDomain || 'https://fallback-domain.com';
  const connectUrl = `${webhookDomain}/connect?${qs.stringify(queryParams)}`;

  const confirmMsg = userState.usePidgin
    ? `📝 *Sell Details* (Step 4/4)\n\n` +
      `*Amount:* ${amount} ${asset.symbol}\n` +
      `*Chain:* ${ctx.wizard.state.chain}\n` +
      `*Bank:* ${bankDetails.bankName} (****${bankDetails.accountNumber.slice(-4)})\n\n` +
      `Connect your wallet now!`
    : `📝 *Sell Details* (Step 4/4)\n\n` +
      `*Amount:* ${amount} ${asset.symbol}\n` +
      `*Chain:* ${ctx.wizard.state.chain}\n` +
      `*Bank:* ${bankDetails.bankName} (****${bankDetails.accountNumber.slice(-4)})\n\n` +
      `Connect your wallet now!`;
  await ctx.replyWithMarkdown(confirmMsg);

  await ctx.replyWithMarkdown(
    `[Connect Wallet](${connectUrl})`,
    Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'cancel_sell')]])
  );
  sellScene.logger.info(`User ${userId} prompted to connect wallet: ${connectUrl}`);
  await ctx.answerCbQuery();
  return ctx.scene.leave();
});

sellScene.action('link_temp_bank', async (ctx) => {
  const userId = ctx.wizard.state.userId;
  sellScene.logger.info(`User ${userId} chose to link a temporary bank`);
  ctx.wizard.state.awaitingTempBank = true;
  await ctx.scene.enter('bank_linking_scene_temp');
  await ctx.answerCbQuery();
});

sellScene.action('cancel_sell', async (ctx) => {
  await ctx.replyWithMarkdown('❌ Sell cancelled.');
  await ctx.answerCbQuery();
  return ctx.scene.leave();
});

sellScene.action('retry_sell', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.replyWithMarkdown('🔄 Restarting sell process. Use /sell to begin.');
  return ctx.scene.leave();
});

// **Setup Function**
function setup(bot, db, logger, getUserState, relayClient) {
  sellScene.getUserState = getUserState;
  sellScene.db = db;
  sellScene.logger = logger;
  sellScene.relayClient = relayClient;
  sellScene.webhookDomain = process.env.WEBHOOK_DOMAIN;

  bot.on('callback_query', async (ctx) => {
    if (ctx.scene.current?.id === 'bank_linking_scene_temp' && ctx.wizard.state.awaitingTempBank) {
      if (ctx.callbackQuery.data === 'confirm_bank_temp') {
        const userId = ctx.wizard.state.userId;
        let userState;
        try {
          userState = await sellScene.getUserState(userId);
          if (!userState) throw new Error('User state not found');
        } catch (err) {
          sellScene.logger.error(`Failed to fetch user state for user ${userId}: ${err.message}`);
          await ctx.replyWithMarkdown(
            '❌ Error fetching your profile. Please try again or contact [@maxcswap](https://t.me/maxcswap).',
            Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]])
          );
          await ctx.answerCbQuery();
          return ctx.scene.leave();
        }

        const { selectedAsset: asset, amount } = ctx.wizard.state;
        const bankDetails = ctx.scene.state.bankDetails;
        const selectedWalletAddress = ctx.scene.state.walletAddress || ctx.wizard.state.selectedWalletAddress;

        if (!asset || !bankDetails || !selectedWalletAddress || !amount) {
          sellScene.logger.error(`Missing details for user ${userId}: asset=${!!asset}, bankDetails=${!!bankDetails}, walletAddress=${!!selectedWalletAddress}, amount=${!!amount}`);
          const errorMsg = userState.usePidgin
            ? '❌ Something miss for your sell. Start again with /sell.'
            : '❌ Missing details for your sell. Please start over with /sell.';
          await ctx.replyWithMarkdown(
            errorMsg,
            Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]])
          );
          await ctx.answerCbQuery();
          return ctx.scene.leave();
        }

        let amountInWei;
        try {
          amountInWei = ethers.utils.parseUnits(amount.toString(), asset.decimals).toString();
        } catch (error) {
          sellScene.logger.error(`Error parsing amount for user ${userId}: ${error.message}`);
          const errorMsg = userState.usePidgin
            ? '❌ Amount no valid for this asset. Start again with /sell.'
            : '❌ Invalid amount for this asset. Please start over with /sell.';
          await ctx.replyWithMarkdown(
            errorMsg,
            Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]])
          );
          await ctx.answerCbQuery();
          return ctx.scene.leave();
        }

        ctx.wizard.state.amountInWei = amountInWei;
        ctx.wizard.state.sessionId = uuidv4();
        ctx.wizard.state.bankDetails = bankDetails;
        ctx.wizard.state.selectedWalletAddress = selectedWalletAddress;

        // Store session in database
        const sessionData = {
          userId,
          amountInWei,
          token: asset.address,
          chainId: mapChainToId(ctx.wizard.state.chain),
          bankDetails,
          blockradarWallet: selectedWalletAddress,
          status: 'pending',
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
        };

        try {
          await sellScene.db.collection('sessions').doc(ctx.wizard.state.sessionId).set(sessionData);
          sellScene.logger.info(`Session stored for user ${userId}, sessionId: ${ctx.wizard.state.sessionId}`);
        } catch (error) {
          sellScene.logger.error(`Failed to store session for user ${userId}: ${error.message}`);
          const errorMsg = userState.usePidgin
            ? '❌ Error saving your sell details. Try again or contact [@maxcswap](https://t.me/maxcswap).'
            : '❌ Error saving your sell details. Try again or contact [@maxcswap](https://t.me/maxcswap).';
          await ctx.replyWithMarkdown(
            errorMsg,
            Markup.inlineKeyboard([[Markup.button.callback('🔄 Retry', 'retry_sell')]])
          );
          await ctx.answerCbQuery();
          return ctx.scene.leave();
        }

        // Encode session data in URL query parameters
        const queryParams = {
          sessionId: ctx.wizard.state.sessionId,
          amountInWei,
          token: asset.address,
          chainId: mapChainToId(ctx.wizard.state.chain).toString(),
          blockradarWallet: selectedWalletAddress,
          bankName: bankDetails.bankName,
          accountNumber: bankDetails.accountNumber.slice(-4),
        };
        const webhookDomain = sellScene.webhookDomain || 'https://fallback-domain.com';
        const connectUrl = `${webhookDomain}/connect?${qs.stringify(queryParams)}`;

        const confirmMsg = userState.usePidgin
          ? `📝 *Sell Details* (Step 4/4)\n\n` +
            `*Amount:* ${amount} ${asset.symbol}\n` +
            `*Chain:* ${ctx.wizard.state.chain}\n` +
            `*Bank:* ${bankDetails.bankName} (****${bankDetails.accountNumber.slice(-4)})\n\n` +
            `Connect your wallet now!`
          : `📝 *Sell Details* (Step 4/4)\n\n` +
            `*Amount:* ${amount} ${asset.symbol}\n` +
            `*Chain:* ${ctx.wizard.state.chain}\n` +
            `*Bank:* ${bankDetails.bankName} (****${bankDetails.accountNumber.slice(-4)})\n\n` +
            `Connect your wallet now!`;
        await ctx.replyWithMarkdown(confirmMsg);

        await ctx.replyWithMarkdown(
          `[Connect Wallet](${connectUrl})`,
          Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'cancel_sell')]])
        );
        sellScene.logger.info(`User ${userId} prompted to connect wallet: ${connectUrl}`);
        ctx.wizard.state.awaitingTempBank = false;
        await ctx.answerCbQuery();
        return ctx.scene.leave();
      }
    }
  });
}

// **Setup Function**
function setup(bot, db, logger, getUserState, relayClient) {
  sellScene.getUserState = getUserState;
  sellScene.db = db;
  sellScene.logger = logger;
  sellScene.relayClient = relayClient;
  sellScene.webhookDomain = process.env.WEBHOOK_DOMAIN;
}

module.exports = { sellScene, setup };
