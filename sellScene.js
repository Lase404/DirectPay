const { Scenes, Markup } = require('telegraf');
const axios = require('axios');
const ethers = require('ethers');
const { v4: uuidv4 } = require('uuid');

const INACTIVITY_TIMEOUT = 5 * 60 * 1000; // 5 minutes

const sellScene = new Scenes.WizardScene(
'sell_scene',
// Step 1: Parse and Validate Input
async (ctx) => {
const userId = ctx.from.id.toString();
const userState = await sellScene.getUserState(userId);
const input = ctx.message.text.replace('/sell', '').trim().split(/\s+/);

sellScene.logger.info(User ${userId} entered sell scene with input: ${ctx.message.text});

if (input.length < 3) {
const errorMsg = userState.usePidgin
? '❌ Format no correct. Use: /sell <amount> <asset/address> <chain>\nE.g., /sell 100 USDC eth'
: '❌ Invalid format. Use: /sell <amount> <asset/address> <chain>\nE.g., /sell 100 USDC eth';
await ctx.replyWithMarkdown(errorMsg, Markup.inlineKeyboard([
[Markup.button.callback('🔄 Retry', 'retry_sell')]
]));
return ctx.scene.leave();
}

const [amountStr, assetInput, chain] = input;
const amount = parseFloat(amountStr);
if (isNaN(amount) || amount <= 0) {
const errorMsg = userState.usePidgin
? '❌ Amount no valid. Enter correct number like 100 or 0.5.'
: '❌ Invalid amount. Please enter a valid number like 100 or 0.5.';
await ctx.replyWithMarkdown(errorMsg, Markup.inlineKeyboard([
[Markup.button.callback('🔄 Retry', 'retry_sell')]
]));
return ctx.scene.leave();
}

ctx.wizard.state = {
userId,
amount,
assetInput,
chain: chain.toLowerCase(),
stepStartedAt: Date.now()
};

await ctx.replyWithMarkdown(userState.usePidgin
? '🔄 Dey check your asset and chain... E fit take small time.'
: '🔄 Verifying your asset and chain... This may take a moment.');

try {
const chainId = mapChainToId(ctx.wizard.state.chain);
if (!chainId) {
throw new Error(Unsupported chain: ${ctx.wizard.state.chain}. Supported: eth, base, bnb, polygon);
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
await ctx.replyWithMarkdown(errorMsg, Markup.inlineKeyboard([
[Markup.button.callback('🔄 Retry', 'retry_sell')]
]));
return ctx.scene.leave();
}

ctx.wizard.state.validatedAssets = assets;
if (assets.length > 1) {
const options = assets.map((asset, index) => [
Markup.button.callback(${asset.symbol} - ${asset.name} (${asset.address.slice(0, 6)}...), select_asset_${index})
]);
options.push([Markup.button.callback('❌ Cancel', 'cancel_sell')]);
await ctx.replyWithMarkdown(userState.usePidgin
? '🤔 Multiple assets dey. Pick the one you want (Step 1/4):'
: '🤔 Multiple assets found. Please select one (Step 1/4):', Markup.inlineKeyboard(options));
ctx.wizard.state.stepStartedAt = Date.now();
return ctx.wizard.next();
} else {
ctx.wizard.state.selectedAsset = assets[0];
return ctx.wizard.selectStep(2); // Skip to bank selection
}
} catch (error) {
sellScene.logger.error(Error validating asset for user ${userId}: ${error.message});
const errorMsg = userState.usePidgin
? ❌ Error checking asset: ${error.message}. Try again or contact [@maxcswap](https://t.me/maxcswap).
: ❌ Error verifying asset: ${error.message}. Try again or contact [@maxcswap](https://t.me/maxcswap).;
await ctx.replyWithMarkdown(errorMsg, Markup.inlineKeyboard([
[Markup.button.callback('🔄 Retry', 'retry_sell')]
]));
return ctx.scene.leave();
}
},
// Step 2: Select Asset (if multiple)
async (ctx) => {
const userId = ctx.wizard.state.userId;
const userState = await sellScene.getUserState(userId);

if (Date.now() - ctx.wizard.state.stepStartedAt > INACTIVITY_TIMEOUT) {
sellScene.logger.info(User ${userId} timed out in asset selection);
await ctx.replyWithMarkdown(userState.usePidgin
? '⏰ You don wait too long. Start again with /sell.'
: '⏰ You’ve been inactive too long. Please start over with /sell.', Markup.inlineKeyboard([
[Markup.button.callback('🔄 Retry', 'retry_sell')]
]));
return ctx.scene.leave();
}

await ctx.replyWithMarkdown(userState.usePidgin
? '⏳ Dey wait for you to pick asset...'
: '⏳ Waiting for you to select an asset...');
},
// Step 3: Bank Selection
async (ctx) => {
const userId = ctx.wizard.state.userId;
const userState = await sellScene.getUserState(userId);
const walletsWithBank = userState.wallets.filter(w => w.bank);

sellScene.logger.info(User ${userId} reached bank selection step. Wallets with bank: ${walletsWithBank.length});

if (!ctx.wizard.state.selectedAsset) {
const errorMsg = userState.usePidgin
? '❌ No asset selected. Start again with /sell.'
: '❌ No asset selected. Please start over with /sell.';
await ctx.replyWithMarkdown(errorMsg, Markup.inlineKeyboard([
[Markup.button.callback('🔄 Retry', 'retry_sell')]
]));
return ctx.scene.leave();
}

const asset = ctx.wizard.state.selectedAsset;
let amountInWei;
try {
amountInWei = ethers.utils.parseUnits(ctx.wizard.state.amount.toString(), asset.decimals).toString();
} catch (error) {
sellScene.logger.error(Error parsing amount for user ${userId}: ${error.message});
const errorMsg = userState.usePidgin
? '❌ Amount no valid for this asset. Start again with /sell.'
: '❌ Invalid amount for this asset. Please start over with /sell.';
await ctx.replyWithMarkdown(errorMsg, Markup.inlineKeyboard([
[Markup.button.callback('🔄 Retry', 'retry_sell')]
]));
return ctx.scene.leave();
}

ctx.wizard.state.amountInWei = amountInWei;
ctx.wizard.state.stepStartedAt = Date.now();

if (walletsWithBank.length === 0) {
const prompt = userState.usePidgin
? '🏦 No bank linked yet. You wan link one for this sell? (Step 2/4)'
: '🏦 No bank linked yet. Would you like to link one for this sell? (Step 2/4)';
await ctx.replyWithMarkdown(prompt, Markup.inlineKeyboard([
[Markup.button.callback('✅ Yes', 'link_temp_bank')],
[Markup.button.callback('❌ Cancel', 'cancel_sell')]
]));
return ctx.wizard.next();
}

const bankOptions = walletsWithBank.map((wallet, index) => [
Markup.button.callback(${wallet.bank.bankName} (****${wallet.bank.accountNumber.slice(-4)}), select_bank_${index})
]);
bankOptions.push([Markup.button.callback('➕ Use Another Bank', 'link_temp_bank')]);
bankOptions.push([Markup.button.callback('❌ Cancel', 'cancel_sell')]);

const assetMsg = userState.usePidgin
? ✅ *Asset Confirmed* (Step 2/4)\n\n +
*Symbol:* ${asset.symbol}\n +
*Name:* ${asset.name}\n +
*Address:* \${asset.address}`\n+        Chain: ${ctx.wizard.state.chain}\n+        Amount: ${ctx.wizard.state.amount} ${asset.symbol}\n\n+        Where you want the funds go?      :✅ Asset Confirmed (Step 2/4)\n\n+        Symbol: ${asset.symbol}\n+        Name: ${asset.name}\n+        Address: `${asset.address}`\n+        Chain: ${ctx.wizard.state.chain}\n+        Amount: ${ctx.wizard.state.amount} ${asset.symbol}\n\n+        Where would you like to receive the funds?`;
await ctx.replyWithMarkdown(assetMsg, Markup.inlineKeyboard(bankOptions));
return ctx.wizard.next();
},
// Step 4: Confirm Bank Selection
async (ctx) => {
const userId = ctx.wizard.state.userId;
const userState = await sellScene.getUserState(userId);

if (!ctx.wizard.state.bankDetails || !ctx.wizard.state.selectedWalletAddress) {
const errorMsg = userState.usePidgin
? '❌ No bank selected. Go back or start again with /sell.'
: '❌ No bank selected. Go back or start over with /sell.';
await ctx.replyWithMarkdown(errorMsg, Markup.inlineKeyboard([
[Markup.button.callback('⬅ Back', 'back_to_bank')],
[Markup.button.callback('🔄 Retry', 'retry_sell')],
[Markup.button.callback('❌ Cancel', 'cancel_sell')]
]));
return;
}

const bankRequiredFields = ['bankName', 'accountNumber', 'accountName'];
const missingBankFields = bankRequiredFields.filter(field => !(field in ctx.wizard.state.bankDetails));
if (missingBankFields.length > 0) {
sellScene.logger.error(Invalid bank details for user ${userId}: Missing fields - ${missingBankFields.join(', ')});
const errorMsg = userState.usePidgin
? '❌ Bank details no complete. Go back to fix am.'
: '❌ Incomplete bank details. Please go back to correct them.';
await ctx.replyWithMarkdown(errorMsg, Markup.inlineKeyboard([
[Markup.button.callback('⬅ Back', 'back_to_bank')],
[Markup.button.callback('🔄 Retry', 'retry_sell')],
[Markup.button.callback('❌ Cancel', 'cancel_sell')]
]));
return;
}

if (Date.now() - ctx.wizard.state.stepStartedAt > INACTIVITY_TIMEOUT) {
sellScene.logger.info(User ${userId} timed out in bank confirmation);
await ctx.replyWithMarkdown(userState.usePidgin
? '⏰ You don wait too long. Start again with /sell.'
: '⏰ You’ve been inactive too long. Please start over with /sell.', Markup.inlineKeyboard([
[Markup.button.callback('🔄 Retry', 'retry_sell')]
]));
return ctx.scene.leave();
}

await ctx.replyWithMarkdown(userState.usePidgin
? '⏳ Dey wait for you to confirm bank details...'
: '⏳ Waiting for you to confirm bank details...');
},
// Step 5: Prompt Wallet Connection
async (ctx) => {
const userId = ctx.wizard.state.userId;
const userState = await sellScene.getUserState(userId);
const { selectedAsset: asset, bankDetails, selectedWalletAddress, amountInWei } = ctx.wizard.state;

if (!asset || !bankDetails || !selectedWalletAddress || !amountInWei) {
const errorMsg = userState.usePidgin
? '❌ Something miss for your sell. Start again with /sell.'
: '❌ Missing details for your sell. Please start over with /sell.';
await ctx.replyWithMarkdown(errorMsg, Markup.inlineKeyboard([
[Markup.button.callback('🔄 Retry', 'retry_sell')]
]));
return ctx.scene.leave();
}

ctx.wizard.state.sessionId = uuidv4();
ctx.wizard.state.stepStartedAt = Date.now();

const confirmMsg = userState.usePidgin
? 📝 *Sell Details* (Step 3/4)\n\n +
*Amount:* ${ctx.wizard.state.amount} ${asset.symbol}\n +
*Chain:* ${ctx.wizard.state.chain}\n +
*Bank:* ${bankDetails.bankName} (****${bankDetails.accountNumber.slice(-4)})\n\n +
Ready to connect your wallet?
: 📝 *Sell Details* (Step 3/4)\n\n +
*Amount:* ${ctx.wizard.state.amount} ${asset.symbol}\n +
*Chain:* ${ctx.wizard.state.chain}\n +
*Bank:* ${bankDetails.bankName} (****${bankDetails.accountNumber.slice(-4)})\n\n +
Ready to connect your wallet?;
await ctx.replyWithMarkdown(confirmMsg);

const sessionData = {
userId,
amountInWei,
token: asset.address,
chainId: asset.chainId,
bankDetails,
blockradarWallet: selectedWalletAddress,
status: 'pending',
createdAt: new Date().toISOString(),
expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString() // 15-minute session
};

sellScene.logger.info(Storing session for user ${userId}, sessionId: ${ctx.wizard.state.sessionId});
try {
await sellScene.db.collection('sessions').doc(ctx.wizard.state.sessionId).set(sessionData);
sellScene.logger.info(Successfully stored session for user ${userId}, sessionId: ${ctx.wizard.state.sessionId});
} catch (error) {
sellScene.logger.error(Failed to store session for user ${userId}: ${error.message});
const errorMsg = userState.usePidgin
? '❌ Error saving your sell details. Try again or contact @maxcswap.'
: '❌ Error saving your sell details. Try again or contact @maxcswap.';
await ctx.replyWithMarkdown(errorMsg, Markup.inlineKeyboard([
[Markup.button.callback('🔄 Retry', 'retry_sell')]
]));
return ctx.scene.leave();
}

const connectUrl = ${sellScene.webhookDomain}/connect?sessionId=${ctx.wizard.state.sessionId};
sellScene.logger.info(Wallet Connection URL for user ${userId}: ${connectUrl});

await ctx.replyWithMarkdown([Connect Wallet](${connectUrl}), Markup.inlineKeyboard([
[Markup.button.callback('⬅ Back', 'back_to_bank')],
[Markup.button.callback('❌ Cancel', 'cancel_sell')]
]));

return ctx.wizard.next();
},
// Step 6: Wait for Wallet Connection and Client-Side Execution
async (ctx) => {
const userId = ctx.wizard.state.userId;
const userState = await sellScene.getUserState(userId);
const sessionId = ctx.wizard.state.sessionId;

if (!sessionId) {
const errorMsg = userState.usePidgin
? '❌ No session found. Start again with /sell.'
: '❌ No session found. Please start over with /sell.';
await ctx.replyWithMarkdown(errorMsg, Markup.inlineKeyboard([
[Markup.button.callback('🔄 Retry', 'retry_sell')]
]));
return ctx.scene.leave();
}

try {
const sessionDoc = await sellScene.db.collection('sessions').doc(sessionId).get();
if (!sessionDoc.exists) {
sellScene.logger.error(Session ${sessionId} not found for user ${userId});
const errorMsg = userState.usePidgin
? '❌ Session no dey again. Start again with /sell.'
: '❌ Session not found. Please start over with /sell.';
await ctx.replyWithMarkdown(errorMsg, Markup.inlineKeyboard([
[Markup.button.callback('🔄 Retry', 'retry_sell')]
]));
return ctx.scene.leave();
}

const session = sessionDoc.data();
const now = new Date();
if (new Date(session.expiresAt) < now) {
sellScene.logger.info(Session ${sessionId} for user ${userId} has expired);
await sellScene.db.collection('sessions').doc(sessionId).update({ status: 'expired' });
await ctx.replyWithMarkdown(userState.usePidgin
? '⏰ Sell process don timeout. Start again with /sell.'
: '⏰ Sell process timed out. Please start over with /sell.', Markup.inlineKeyboard([
[Markup.button.callback('🔄 Retry', 'retry_sell')]
]));
return ctx.scene.leave();
}

if (session.status === 'completed') {
await ctx.replyWithMarkdown(userState.usePidgin
? '✅ Sell complete! Check your bank for the money.'
: '✅ Sell completed! Check your bank for the payout.', Markup.inlineKeyboard([
[Markup.button.callback('🔄 Sell Again', 'retry_sell')]
]));
return ctx.scene.leave();
}

await ctx.replyWithMarkdown(userState.usePidgin
? '⏳ Dey wait for you to finish the sell for browser... (Step 4/4)\nMake you connect your wallet quick quick!'
: '⏳ Waiting for you to complete the sell in your browser... (Step 4/4)\nPlease connect your wallet promptly!', Markup.inlineKeyboard([
[Markup.button.callback('⬅ Back', 'back_to_bank')],
[Markup.button.callback('❌ Cancel', 'cancel_sell')]
]));
} catch (error) {
sellScene.logger.error(Error checking session for user ${userId}: ${error.message});
const errorMsg = userState.usePidgin
? '❌ Error checking your sell. Try again or contact @maxcswap.'
: '❌ Error checking your sell. Try again or contact @maxcswap.';
await ctx.replyWithMarkdown(errorMsg, Markup.inlineKeyboard([
[Markup.button.callback('🔄 Retry', 'retry_sell')]
]));
return ctx.scene.leave();
}
}
);

// Helper Functions
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

async function validateAssetByAddress(address, chainId, relayClient) {
try {
sellScene.logger.info(Validating asset by address: ${address} on chainId: ${chainId});
const response = await axios.post('https://api.relay.link/currencies/v1', {
chainIds: [chainId],
term: address,
verified: true,
limit: 10,
includeAllChains: false,
useExternalSearch: true,
depositAddressOnly: true
}, { headers: { 'Content-Type': 'application/json' } });
sellScene.logger.info(Relay.link response for address ${address}: ${JSON.stringify(response.data)});
return response.data.flat();
} catch (error) {
sellScene.logger.error(Address validation failed for address ${address}: ${error.message});
throw error;
}
}

async function validateAssetByTerm(term, chainId, relayClient) {
try {
sellScene.logger.info(Validating asset by term: ${term} on chainId: ${chainId});
const response = await axios.post('https://api.relay.link/currencies/v1', {
chainIds: [chainId],
term,
verified: true,
limit: 10,
includeAllChains: false,
useExternalSearch: true,
depositAddressOnly: true
}, { headers: { 'Content-Type': 'application/json' } });
sellScene.logger.info(Relay.link response for term ${term}: ${JSON.stringify(response.data)});
return response.data.flat();
} catch (error) {
sellScene.logger.error(Term validation failed for term ${term}: ${error.message});
throw error;
}
}

// Actions
sellScene.action(/select_asset_(\d+)/, async (ctx) => {
const index = parseInt(ctx.match[1], 10);
const userId = ctx.wizard.state.userId;
const userState = await sellScene.getUserState(userId);
const assets = ctx.wizard.state.validatedAssets;

sellScene.logger.info(User ${userId} selected asset index ${index});

if (!assets || index < 0 || index >= assets.length) {
await ctx.replyWithMarkdown(userState.usePidgin
? '❌ Asset no valid. Pick again or cancel.'
: '❌ Invalid asset selection. Try again or cancel.', Markup.inlineKeyboard([
[Markup.button.callback('⬅ Back', 'back_to_asset')],
[Markup.button.callback('❌ Cancel', 'cancel_sell')]
]));
await ctx.answerCbQuery();
return;
}

ctx.wizard.state.selectedAsset = assets[index];
ctx.wizard.state.stepStartedAt = Date.now();
await ctx.answerCbQuery();
return ctx.wizard.selectStep(2);
});

sellScene.action(/select_bank_(\d+)/, async (ctx) => {
const index = parseInt(ctx.match[1], 10);
const userId = ctx.wizard.state.userId;
const userState = await sellScene.getUserState(userId);
const walletsWithBank = userState.wallets.filter(w => w.bank);

sellScene.logger.info(User ${userId} selected bank index ${index});

if (index < 0 || index >= walletsWithBank.length) {
await ctx.replyWithMarkdown(userState.usePidgin
? '❌ Bank no valid. Pick again or cancel.'
: '❌ Invalid bank selection. Try again or cancel.', Markup.inlineKeyboard([
[Markup.button.callback('⬅ Back', 'back_to_bank')],
[Markup.button.callback('❌ Cancel', 'cancel_sell')]
]));
await ctx.answerCbQuery();
return;
}

ctx.wizard.state.bankDetails = walletsWithBank[index].bank;
ctx.wizard.state.selectedWalletAddress = walletsWithBank[index].address;
ctx.wizard.state.stepStartedAt = Date.now();

const confirmMsg = userState.usePidgin
? 🏦 You go receive funds to:\n +
*Bank:* ${ctx.wizard.state.bankDetails.bankName}\n +
*Account:* ****${ctx.wizard.state.bankDetails.accountNumber.slice(-4)}\n +
*Name:* ${ctx.wizard.state.bankDetails.accountName}\n\n +
E correct? (Step 3/4)
: 🏦 Funds will be sent to:\n +
*Bank:* ${ctx.wizard.state.bankDetails.bankName}\n +
*Account:* ****${ctx.wizard.state.bankDetails.accountNumber.slice(-4)}\n +
*Name:* ${ctx.wizard.state.bankDetails.accountName}\n\n +
Is this correct? (Step 3/4);
await ctx.replyWithMarkdown(confirmMsg, Markup.inlineKeyboard([
[Markup.button.callback('✅ Yes', 'confirm_bank')],
[Markup.button.callback('⬅ Back', 'back_to_bank')],
[Markup.button.callback('❌ Cancel', 'cancel_sell')]
]));
await ctx.answerCbQuery();
});

sellScene.action('confirm_bank', async (ctx) => {
const userId = ctx.wizard.state.userId;
const userState = await sellScene.getUserState(userId);

sellScene.logger.info(User ${userId} confirmed bank selection);

try {
ctx.wizard.state.stepStartedAt = Date.now();
await ctx.answerCbQuery();
return ctx.wizard.selectStep(4);
} catch (error) {
sellScene.logger.error(Error advancing to wallet connection for user ${userId}: ${error.message});
const errorMsg = userState.usePidgin
? '❌ Error going to wallet connection. Try again or contact @maxcswap.'
: '❌ Error proceeding to wallet connection. Try again or contact @maxcswap.';
await ctx.replyWithMarkdown(errorMsg, Markup.inlineKeyboard([
[Markup.button.callback('🔄 Retry', 'retry_sell')]
]));
return ctx.scene.leave();
}
});

sellScene.action('link_temp_bank', async (ctx) => {
const userId = ctx.wizard.state.userId;
sellScene.logger.info(User ${userId} chose to link a temporary bank);
ctx.wizard.state.awaitingTempBank = true;
await ctx.scene.enter('bank_linking_scene_temp');
await ctx.answerCbQuery();
});

sellScene.action('back_to_asset', async (ctx) => {
const userId = ctx.wizard.state.userId;
const userState = await sellScene.getUserState(userId);
const assets = ctx.wizard.state.validatedAssets;

sellScene.logger.info(User ${userId} returned to asset selection);

if (!assets || assets.length === 0) {
await ctx.replyWithMarkdown(userState.usePidgin
? '❌ No assets to pick. Start again with /sell.'
: '❌ No assets to select. Please start over with /sell.', Markup.inlineKeyboard([
[Markup.button.callback('🔄 Retry', 'retry_sell')]
]));
await ctx.answerCbQuery();
return ctx.scene.leave();
}

const options = assets.map((asset, index) => [
Markup.button.callback(${asset.symbol} - ${asset.name} (${asset.address.slice(0, 6)}...), select_asset_${index})
]);
options.push([Markup.button.callback('❌ Cancel', 'cancel_sell')]);

await ctx.replyWithMarkdown(userState.usePidgin
? '🤔 Pick the asset you want (Step 1/4):'
: '🤔 Please select an asset (Step 1/4):', Markup.inlineKeyboard(options));
ctx.wizard.state.stepStartedAt = Date.now();
await ctx.answerCbQuery();
return ctx.wizard.selectStep(1);
});

sellScene.action('back_to_bank', async (ctx) => {
const userId = ctx.wizard.state.userId;
const userState = await sellScene.getUserState(userId);
const walletsWithBank = userState.wallets.filter(w => w.bank);

sellScene.logger.info(User ${userId} returned to bank selection);

if (!ctx.wizard.state.selectedAsset) {
await ctx.replyWithMarkdown(userState.usePidgin
? '❌ No asset selected. Start again with /sell.'
: '❌ No asset selected. Please start over with /sell.', Markup.inlineKeyboard([
[Markup.button.callback('🔄 Retry', 'retry_sell')]
]));
await ctx.answerCbQuery();
return ctx.scene.leave();
}

const bankOptions = walletsWithBank.map((wallet, index) => [
Markup.button.callback(${wallet.bank.bankName} (****${wallet.bank.accountNumber.slice(-4)}), select_bank_${index})
]);
bankOptions.push([Markup.button.callback('➕ Use Another Bank', 'link_temp_bank')]);
bankOptions.push([Markup.button.callback('❌ Cancel', 'cancel_sell')]);

const assetMsg = userState.usePidgin
? ✅ *Asset Confirmed* (Step 2/4)\n\n +
*Symbol:* ${ctx.wizard.state.selectedAsset.symbol}\n +
*Name:* ${ctx.wizard.state.selectedAsset.name}\n +
*Address:* \${ctx.wizard.state.selectedAsset.address}`\n+      Chain: ${ctx.wizard.state.chain}\n+      Amount: ${ctx.wizard.state.amount} ${ctx.wizard.state.selectedAsset.symbol}\n\n+      Where you want the funds go?    :✅ Asset Confirmed (Step 2/4)\n\n+      Symbol: ${ctx.wizard.state.selectedAsset.symbol}\n+      Name: ${ctx.wizard.state.selectedAsset.name}\n+      Address: `${ctx.wizard.state.selectedAsset.address}`\n+      Chain: ${ctx.wizard.state.chain}\n+      Amount: ${ctx.wizard.state.amount} ${ctx.wizard.state.selectedAsset.symbol}\n\n+      Where would you like to receive the funds?`;
await ctx.replyWithMarkdown(assetMsg, Markup.inlineKeyboard(bankOptions));
ctx.wizard.state.stepStartedAt = Date.now();
await ctx.answerCbQuery();
return ctx.wizard.selectStep(2);
});

sellScene.action('retry_sell', async (ctx) => {
sellScene.logger.info(User ${ctx.wizard.state.userId} requested to retry sell);
await ctx.answerCbQuery();
await ctx.scene.enter('sell_scene');
});

sellScene.action('cancel_sell', async (ctx) => {
const userId = ctx.wizard.state.userId;
const userState = await sellScene.getUserState(userId);
sellScene.logger.info(User ${userId} cancelled the sell process);
await ctx.replyWithMarkdown(userState.usePidgin
? '❌ Sell cancelled. You fit start again with /sell.'
: '❌ Sell process cancelled. You can start over with /sell.', Markup.inlineKeyboard([
[Markup.button.callback('🔄 Retry', 'retry_sell')]
]));
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

bot.on('callback_query', async (ctx) => {
if (ctx.scene.current?.id === 'bank_linking_scene_temp' && ctx.wizard.state.awaitingTempBank) {
if (ctx.callbackQuery.data === 'confirm_bank_temp') {
sellScene.logger.info(User ${ctx.wizard.state.userId} confirmed temporary bank linking);
ctx.wizard.state.bankDetails = ctx.scene.state.bankDetails;
ctx.wizard.state.selectedWalletAddress = ctx.scene.state.walletAddress || ctx.wizard.state.selectedWalletAddress;
ctx.wizard.state.stepStartedAt = Date.now();
await ctx.answerCbQuery();
await ctx.wizard.selectStep(3);
}
}
});
}

module.exports = { sellScene, setup };
