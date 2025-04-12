const { Scenes, Markup } = require('telegraf');
const axios = require('axios');
const ethers = require('ethers');
const { v4: uuidv4 } = require('uuid');

const sellScene = new Scenes.WizardScene(
  'sell_scene',
  // Step 1: Parse and Validate Input
  async (ctx) => {
    const userId = ctx.from.id.toString();
    const userState = await sellScene.getUserState(userId);
    const input = ctx.message.text.replace('/sell', '').trim().split(/\s+/);

    sellScene.logger.info(`User ${userId} entered sell scene with input: ${ctx.message.text}`);

    if (input.length < 3) {
      const errorMsg = userState.usePidgin
        ? '❌ Format no correct. Use: /sell <amount> <asset/address> <chain>'
        : '❌ Invalid format. Use: /sell <amount> <asset/address> <chain>';
      await ctx.replyWithMarkdown(errorMsg);
      return ctx.scene.leave();
    }

    const [amountStr, assetInput, chain] = input;
    const amount = parseFloat(amountStr);
    if (isNaN(amount) || amount <= 0) {
      const errorMsg = userState.usePidgin
        ? '❌ Amount no valid. Enter correct number.'
        : '❌ Invalid amount. Please enter a valid number.';
      await ctx.replyWithMarkdown(errorMsg);
      return ctx.scene.leave();
    }

    ctx.wizard.state.userId = userId;
    ctx.wizard.state.amount = amount;
    ctx.wizard.state.assetInput = assetInput;
    ctx.wizard.state.chain = chain.toLowerCase();

    await ctx.replyWithMarkdown(userState.usePidgin
      ? '🔄 Dey check your asset and chain...'
      : '🔄 Verifying your asset and chain...');

    try {
      const chainId = mapChainToId(ctx.wizard.state.chain);
      if (!chainId) throw new Error('Unsupported chain');

      let assets;
      if (ethers.utils.isAddress(assetInput)) {
        assets = await validateAssetByAddress(ctx.wizard.state.assetInput, chainId, sellScene.relayClient);
      } else {
        assets = await validateAssetByTerm(ctx.wizard.state.assetInput, chainId, sellScene.relayClient);
      }

      if (!assets || assets.length === 0) {
        const errorMsg = userState.usePidgin
          ? '❌ No asset match your input for this chain. Try again.'
          : '❌ No matching assets found for this chain. Please try again.';
        await ctx.replyWithMarkdown(errorMsg);
        return ctx.scene.leave();
      }

      ctx.wizard.state.validatedAssets = assets;
      if (assets.length > 1) {
        const options = assets.map((asset, index) => [
          Markup.button.callback(`${asset.symbol} - ${asset.name} (${asset.address.slice(0, 6)}...)`, `select_asset_${index}`)
        ]);
        await ctx.replyWithMarkdown(userState.usePidgin
          ? '🤔 Multiple assets dey. Pick the one you want:'
          : '🤔 Multiple assets found. Please select the one you intend to sell:', Markup.inlineKeyboard(options));
        return ctx.wizard.next();
      } else {
        ctx.wizard.state.selectedAsset = assets[0];
        return ctx.wizard.selectStep(2); // Skip to bank selection
      }
    } catch (error) {
      sellScene.logger.error(`Error validating asset for user ${userId}: ${error.message}`);
      const errorMsg = userState.usePidgin
        ? '❌ Error checking asset. Try again or contact [@maxcswap](https://t.me/maxcswap).'
        : '❌ Error verifying asset. Try again or contact [@maxcswap](https://t.me/maxcswap).';
      await ctx.replyWithMarkdown(errorMsg);
      return ctx.scene.leave();
    }
  },
  // Step 2: Select Asset (if multiple)
  async (ctx) => {
    // Handled by action below
  },
  // Step 3: Bank Selection
  async (ctx) => {
    const userId = ctx.wizard.state.userId;
    const userState = await sellScene.getUserState(userId);
    const walletsWithBank = userState.wallets.filter(w => w.bank);

    sellScene.logger.info(`User ${userId} reached bank selection step. Wallets with bank: ${walletsWithBank.length}`);

    if (!ctx.wizard.state.selectedAsset) {
      const errorMsg = userState.usePidgin
        ? '❌ No asset selected. Start again with /sell.'
        : '❌ No asset selected. Please start over with /sell.';
      await ctx.replyWithMarkdown(errorMsg);
      return ctx.scene.leave();
    }

    const asset = ctx.wizard.state.selectedAsset;
    const amountInWei = ethers.utils.parseUnits(ctx.wizard.state.amount.toString(), asset.decimals).toString();

    ctx.wizard.state.amountInWei = amountInWei;

    if (walletsWithBank.length === 0) {
      const prompt = userState.usePidgin
        ? '🏦 No bank linked yet. You wan link one for this sell?'
        : '🏦 No bank linked yet. Would you like to link one for this sell?';
      await ctx.replyWithMarkdown(prompt, Markup.inlineKeyboard([
        [Markup.button.callback('✅ Yes', 'link_temp_bank')],
        [Markup.button.callback('❌ No', 'cancel_sell')]
      ]));
      return ctx.wizard.next();
    }

    const bankOptions = walletsWithBank.map((wallet, index) => [
      Markup.button.callback(`${wallet.bank.bankName} (****${wallet.bank.accountNumber.slice(-4)})`, `select_bank_${index}`)
    ]);
    bankOptions.push([Markup.button.callback('➕ Use Another Bank', 'link_temp_bank')]);

    const assetMsg = userState.usePidgin
      ? `✅ *Asset Confirmed*\n\n` +
        `*Symbol:* ${asset.symbol}\n` +
        `*Name:* ${asset.name}\n` +
        `*Address:* \`${asset.address}\`\n` +
        `*Chain:* ${ctx.wizard.state.chain}\n\n` +
        `Where you want the funds go?`
      : `✅ *Asset Confirmed*\n\n` +
        `*Symbol:* ${asset.symbol}\n` +
        `*Name:* ${asset.name}\n` +
        `*Address:* \`${asset.address}\`\n` +
        `*Chain:* ${ctx.wizard.state.chain}\n\n` +
        `Where would you like to receive the funds?`;
    await ctx.replyWithMarkdown(assetMsg, Markup.inlineKeyboard(bankOptions));
    return ctx.wizard.next();
  },
  // Step 4: Confirm Bank and Proceed to Wallet Connection
  async (ctx) => {
    // Handled by actions below
  },
  // Step 5: Prompt for Wallet Connection
  async (ctx) => {
    const userId = ctx.wizard.state.userId;
    const userState = await sellScene.getUserState(userId);
    const asset = ctx.wizard.state.selectedAsset;
    const bankDetails = ctx.wizard.state.bankDetails;

    sellScene.logger.info(`User ${userId} reached wallet connection step. Asset: ${asset.symbol}, Bank: ${bankDetails.bankName}`);

    if (!bankDetails) {
      const errorMsg = userState.usePidgin
        ? '❌ No bank selected. Start again with /sell.'
        : '❌ No bank selected. Please start over with /sell.';
      await ctx.replyWithMarkdown(errorMsg);
      return ctx.scene.leave();
    }

    ctx.wizard.state.sessionId = uuidv4();

    const confirmMsg = userState.usePidgin
      ? `📝 *Sell Details*\n\n` +
        `*Amount:* ${ctx.wizard.state.amount} ${asset.symbol}\n` +
        `*Chain:* ${ctx.wizard.state.chain}\n` +
        `*Bank:* ${bankDetails.bankName} (****${bankDetails.accountNumber.slice(-4)})\n\n` +
        `Ready to connect your wallet to proceed?`
      : `📝 *Sell Details*\n\n` +
        `*Amount:* ${ctx.wizard.state.amount} ${asset.symbol}\n` +
        `*Chain:* ${ctx.wizard.state.chain}\n` +
        `*Bank:* ${bankDetails.bankName} (****${bankDetails.accountNumber.slice(-4)})\n\n` +
        `Ready to connect your wallet to proceed?`;
    await ctx.replyWithMarkdown(confirmMsg);

    const connectUrl = `${sellScene.webhookDomain}/connect?userId=${userId}`;
    sellScene.logger.info(`Wallet Connection URL for user ${userId}: ${connectUrl}`);

    await ctx.replyWithMarkdown(`[Connect Wallet](${connectUrl})`);

    const sessionData = {
      userId,
      amountInWei: ctx.wizard.state.amountInWei,
      token: asset.address,
      chainId: asset.chainId,
      bankDetails,
      blockradarWallet: ctx.wizard.state.selectedWalletAddress,
      status: 'pending',
      createdAt: new Date().toISOString()
    };
    sellScene.logger.info(`Storing session for user ${userId}, sessionId: ${ctx.wizard.state.sessionId}, data: ${JSON.stringify(sessionData)}`);

    try {
      await sellScene.db.collection('sessions').doc(ctx.wizard.state.sessionId).set(sessionData);
      sellScene.logger.info(`Successfully stored session for user ${userId}, sessionId: ${ctx.wizard.state.sessionId}`);
    } catch (error) {
      sellScene.logger.error(`Failed to store session for user ${userId}, sessionId: ${ctx.wizard.state.sessionId}: ${error.message}`);
      const errorMsg = userState.usePidgin
        ? '❌ Error saving session. Try again or contact [@maxcswap](https://t.me/maxcswap).'
        : '❌ Error saving session. Try again or contact [@maxcswap](https://t.me/maxcswap).';
      await ctx.replyWithMarkdown(errorMsg);
      return ctx.scene.leave();
    }

    return ctx.wizard.next();
  },
  // Step 6: Wait for Wallet Connection and Client-Side Execution
  async (ctx) => {
    const userState = await sellScene.getUserState(ctx.wizard.state.userId);
    await ctx.replyWithMarkdown(userState.usePidgin
      ? '⏳ Dey wait for you to complete the sell for browser...'
      : '⏳ Waiting for you to complete the sell in your browser...');
  }
);

// Helper Functions
function mapChainToId(chain) {
  const chainMap = {
    'eth': 1,
    'ethereum': 1,
    'polygon': 137,
    'bnb': 56,
    'base': 8453,
  };
  return chainMap[chain.toLowerCase()];
}

async function validateAssetByAddress(address, chainId, relayClient) {
  try {
    sellScene.logger.info(`Validating asset by address: ${address} on chainId: ${chainId}`);
    const response = await axios.post('https://api.relay.link/currencies/v1', {
      chainIds: [chainId],
      term: address,
      verified: true,
      limit: 10,
      includeAllChains: false,
      useExternalSearch: true,
      depositAddressOnly: true
    }, { headers: { 'Content-Type': 'application/json' } });
    sellScene.logger.info(`Relay.link response for address ${address}: ${JSON.stringify(response.data)}`);
    return response.data.flat();
  } catch (error) {
    sellScene.logger.error(`Address validation failed for address ${address}: ${error.message}`);
    throw new Error(`Address validation failed: ${error.message}`);
  }
}

async function validateAssetByTerm(term, chainId, relayClient) {
  try {
    sellScene.logger.info(`Validating asset by term: ${term} on chainId: ${chainId}`);
    const response = await axios.post('https://api.relay.link/currencies/v1', {
      chainIds: [chainId],
      term,
      verified: true,
      limit: 10,
      includeAllChains: false,
      useExternalSearch: true,
      depositAddressOnly: true
    }, { headers: { 'Content-Type': 'application/json' } });
    sellScene.logger.info(`Relay.link response for term ${term}: ${JSON.stringify(response.data)}`);
    return response.data.flat();
  } catch (error) {
    sellScene.logger.error(`Term validation failed for term ${term}: ${error.message}`);
    throw new Error(`Term validation failed: ${error.message}`);
  }
}

// Actions
sellScene.action(/select_asset_(\d+)/, async (ctx) => {
  const index = parseInt(ctx.match[1], 10);
  const userState = await sellScene.getUserState(ctx.wizard.state.userId);
  const assets = ctx.wizard.state.validatedAssets;

  sellScene.logger.info(`User ${ctx.wizard.state.userId} selected asset index ${index}`);

  if (index >= 0 && index < assets.length) {
    ctx.wizard.state.selectedAsset = assets[index];
    await ctx.answerCbQuery();
    return ctx.wizard.selectStep(2);
  } else {
    await ctx.replyWithMarkdown(userState.usePidgin
      ? '❌ Asset no valid. Pick again.'
      : '❌ Invalid asset selection. Please try again.');
    await ctx.answerCbQuery();
  }
});

sellScene.action(/select_bank_(\d+)/, async (ctx) => {
  const index = parseInt(ctx.match[1], 10);
  const userId = ctx.wizard.state.userId;
  const userState = await sellScene.getUserState(userId);
  const walletsWithBank = userState.wallets.filter(w => w.bank);

  sellScene.logger.info(`User ${userId} selected bank index ${index}`);

  if (index >= 0 && index < walletsWithBank.length) {
    ctx.wizard.state.bankDetails = walletsWithBank[index].bank;
    ctx.wizard.state.selectedWalletAddress = walletsWithBank[index].address;
    ctx.wizard.state.sessionId = uuidv4();
    const confirmMsg = userState.usePidgin
      ? `🏦 You go receive funds to:\n` +
        `*Bank:* ${ctx.wizard.state.bankDetails.bankName}\n` +
        `*Account:* ****${ctx.wizard.state.bankDetails.accountNumber.slice(-4)}\n` +
        `*Name:* ${ctx.wizard.state.bankDetails.accountName}\n\n` +
        `E correct?`
      : `🏦 Funds will be sent to:\n` +
        `*Bank:* ${ctx.wizard.state.bankDetails.bankName}\n` +
        `*Account:* ****${ctx.wizard.state.bankDetails.accountNumber.slice(-4)}\n` +
        `*Name:* ${ctx.wizard.state.bankDetails.accountName}\n\n` +
        `Is this correct?`;
    await ctx.replyWithMarkdown(confirmMsg, Markup.inlineKeyboard([
      [Markup.button.callback('✅ Yes', 'confirm_bank')],
      [Markup.button.callback('❌ No', 'cancel_sell')]
    ]));
    await ctx.answerCbQuery();
  }
});

sellScene.action('link_temp_bank', async (ctx) => {
  sellScene.logger.info(`User ${ctx.wizard.state.userId} chose to link a temporary bank`);
  await ctx.scene.enter('bank_linking_scene_temp');
  ctx.wizard.state.awaitingTempBank = true;
  await ctx.answerCbQuery();
});

sellScene.action('confirm_bank', async (ctx) => {
  const userId = ctx.wizard.state.userId;
  sellScene.logger.info(`User ${userId} confirmed bank selection`);
  return ctx.wizard.selectStep(4);
});

sellScene.action('cancel_sell', async (ctx) => {
  const userState = await sellScene.getUserState(ctx.wizard.state.userId);
  sellScene.logger.info(`User ${ctx.wizard.state.userId} cancelled the sell process`);
  await ctx.replyWithMarkdown(userState.usePidgin
    ? '❌ Sell cancelled.'
    : '❌ Sell process cancelled.');
  await ctx.answerCbQuery();
  return ctx.scene.leave();
});

// Setup Function
function setup(bot, db, logger, getUserState, updateUserState, relayClient, privyClient, exchangeRates, chains) {
  sellScene.getUserState = getUserState;
  sellScene.db = db;
  sellScene.logger = logger;
  sellScene.relayClient = relayClient;
  sellScene.privyClient = privyClient;
  sellScene.exchangeRates = exchangeRates;
  sellScene.chains = chains;
  sellScene.webhookDomain = process.env.WEBHOOK_DOMAIN;

  // Handle temp bank linking completion
  bot.on('callback_query', async (ctx) => {
    if (ctx.scene.current?.id === 'bank_linking_scene_temp' && ctx.wizard.state.awaitingTempBank) {
      if (ctx.callbackQuery.data === 'confirm_bank_temp') {
        sellScene.logger.info(`User ${ctx.wizard.state.userId} confirmed temporary bank linking`);
        ctx.wizard.state.bankDetails = ctx.scene.state.bankDetails;
        ctx.wizard.state.sessionId = uuidv4();
        await ctx.wizard.selectStep(4);
      }
    }
  });
}

module.exports = { sellScene, setup };
