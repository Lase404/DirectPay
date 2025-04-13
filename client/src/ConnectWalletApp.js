import React, { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { PrivyProvider, usePrivy, useWallets } from '@privy-io/react-auth';
import { getClient } from '@reservoir0x/relay-sdk';
import { adaptEthersSigner } from '@reservoir0x/relay-ethers-wallet-adapter';
import { ethers } from 'ethers';
import axios from 'axios';
import { toast, ToastContainer } from 'react-toastify';
import { FaWallet, FaCheckCircle, FaPaperPlane, FaSpinner, FaCopy, FaExternalLinkAlt } from 'react-icons/fa';
import QRCode from 'react-qr-code';
import 'react-toastify/dist/ReactToastify.css';
import './ConnectWalletApp.css';

// Supported chains configuration
const SUPPORTED_CHAINS = {
  1: {
    name: 'Ethereum',
    chainId: 1,
    rpcUrl: `https://mainnet.infura.io/v3/${process.env.REACT_APP_INFURA_PROJECT_ID}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    blockExplorer: 'https://etherscan.io',
  },
  8453: {
    name: 'Base',
    chainId: 8453,
    rpcUrl: `https://base-mainnet.infura.io/v3/${process.env.REACT_APP_INFURA_PROJECT_ID}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    blockExplorer: 'https://basescan.org',
  },
  56: {
    name: 'BNB Chain',
    chainId: 56,
    rpcUrl: 'https://bsc-dataseed.binance.org/',
    nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
    blockExplorer: 'https://bscscan.com',
  },
  137: {
    name: 'Polygon',
    chainId: 137,
    rpcUrl: `https://polygon-mainnet.infura.io/v3/${process.env.REACT_APP_INFURA_PROJECT_ID}`,
    nativeCurrency: { name: 'MATIC', symbol: 'MATIC', decimals: 18 },
    blockExplorer: 'https://polygonscan.com',
  },
};

// Utility Functions
const formatUSD = (value) => (!value ? '0.00' : parseFloat(value).toFixed(2));

const formatTokenAmount = (amount, decimals) => {
  try {
    return ethers.utils.formatUnits(amount, decimals);
  } catch {
    return amount.toString();
  }
};

const switchChain = async (chainId) => {
  const chainConfig = SUPPORTED_CHAINS[chainId];
  if (!chainConfig) throw new Error(`Unsupported chain ID: ${chainId}`);

  const provider = new ethers.providers.Web3Provider(window.ethereum);
  const currentChainId = (await provider.getNetwork()).chainId;

  if (currentChainId !== chainId) {
    try {
      await window.ethereum.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: `0x${chainId.toString(16)}` }],
      });
    } catch (switchError) {
      if (switchError.code === 4902) {
        await window.ethereum.request({
          method: 'wallet_addEthereumChain',
          params: [{
            chainId: `0x${chainId.toString(16)}`,
            chainName: chainConfig.name,
            rpcUrls: [chainConfig.rpcUrl],
            nativeCurrency: chainConfig.nativeCurrency,
            blockExplorerUrls: [chainConfig.blockExplorer],
          }],
        });
      } else {
        throw switchError;
      }
    }
  }
};

const getTokenInfo = async (token, chainId) => {
  if (token === '0x0000000000000000000000000000000000000000') {
    const chainConfig = SUPPORTED_CHAINS[chainId];
    return {
      symbol: chainConfig?.nativeCurrency.symbol || 'Token',
      decimals: chainConfig?.nativeCurrency.decimals || 18,
    };
  }

  try {
    const chainConfig = SUPPORTED_CHAINS[chainId];
    const provider = new ethers.providers.JsonRpcProvider(chainConfig.rpcUrl);
    const tokenContract = new ethers.Contract(
      token,
      ['function symbol() view returns (string)', 'function decimals() view returns (uint8)'],
      provider
    );
    const [symbol, decimals] = await Promise.all([tokenContract.symbol(), tokenContract.decimals()]);
    return { symbol, decimals };
  } catch (err) {
    console.error('Failed to fetch token metadata:', err);
    toast.warn('Could not fetch token details. Using default values.');
    return { symbol: 'Token', decimals: 18 };
  }
};

const fetchQuote = async (wallet, session) => {
  const provider = await wallet.getEthersProvider();
  const signer = await provider.getSigner();
  const adaptedWallet = adaptEthersSigner(signer);
  return await getClient().actions.getQuote({
    chainId: session.chainId,
    toChainId: 8453,
    currency: session.token,
    toCurrency: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC on Base
    tradeType: 'EXACT_INPUT',
    amount: session.amountInWei,
    wallet: adaptedWallet,
    recipient: session.blockradarWallet,
  });
};

const handleSell = async (wallet, session, quote, setLoading, setStatus, setTxHash, sessionId) => {
  const provider = await wallet.getEthersProvider();
  const signer = provider.getSigner();
  const adaptedWallet = adaptEthersSigner(signer);

  setLoading(true);
  setStatus('Initiating transaction...');

  try {
    await switchChain(session.chainId);
    let latestTxHash = null;

    await getClient().actions.execute({
      quote,
      wallet: adaptedWallet,
      depositGasLimit: '500000',
      onProgress: async (progress) => {
        const { currentStep, currentStepItem, txHashes, error } = progress;

        if (error || currentStep?.error || currentStepItem?.error) {
          throw new Error(error?.message || 'Transaction failed');
        }

        if (currentStep?.id === 'approve' && currentStepItem?.status === 'incomplete') {
          setStatus('Awaiting approval in your wallet...');
          toast.info('Please approve the transaction in your wallet.');
        } else if (currentStep?.id === 'deposit' && currentStepItem?.status === 'incomplete') {
          setStatus('Depositing funds to relayer...');
          toast.info('Please confirm the deposit transaction.');
        }

        if (txHashes && txHashes.length > 0) {
          latestTxHash = txHashes[txHashes.length - 1].txHash;
          setTxHash(latestTxHash);
          setStatus(`Transaction submitted: ${latestTxHash.slice(0, 6)}...`);
          toast.success(`Transaction submitted: ${latestTxHash.slice(0, 6)}...`);
        }
      },
    });

    if (latestTxHash) {
      try {
        await axios.post('/webhook/sell-completed', {
          sessionId,
          txHash: latestTxHash,
        });
        setStatus('Sell completed successfully!');
        toast.success('Sell completed! Funds will be sent to your bank.');
      } catch (webhookErr) {
        setStatus('Sell completed, but notification failed');
        toast.warn('Sell completed, but server notification failed. Contact support.');
      }
    } else {
      throw new Error('No transaction hash received');
    }
  } catch (err) {
    setStatus('Error during sell');
    toast.error(`Error: ${err.message}`);
  } finally {
    setLoading(false);
  }
};

// Main Component
const ConnectWalletApp = () => {
  const { ready, authenticated, login, logout } = usePrivy();
  const { wallets } = useWallets();
  const [session, setSession] = useState(null);
  const [quote, setQuote] = useState(null);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('idle');
  const [tokenInfo, setTokenInfo] = useState({ symbol: 'Token', decimals: 18 });
  const [txHash, setTxHash] = useState(null);
  const location = useLocation();

  useEffect(() => {
    getClient({ baseApiUrl: 'https://api.relay.link', source: 'directpay-app' });
  }, []);

  useEffect(() => {
    const validateSession = async () => {
      const params = new URLSearchParams(location.search);
      const sessionId = params.get('sessionId');
      const hash = params.get('hash');

      if (!sessionId || !hash) {
        toast.error('Missing session ID or hash');
        return;
      }

      try {
        const response = await axios.get(`/api/validate-session?sessionId=${sessionId}&hash=${hash}`);
        const data = response.data;

        // Validate required fields
        const requiredFields = ['amountInWei', 'token', 'chainId', 'blockradarWallet', 'bankDetails'];
        const missingFields = requiredFields.filter(field => !(field in data));
        if (missingFields.length > 0) {
          throw new Error(`Missing session fields: ${missingFields.join(', ')}`);
        }

        if (!data.bankDetails.bankName || !data.bankDetails.accountNumber || !data.bankDetails.accountName) {
          throw new Error('Incomplete bank details');
        }

        if (!SUPPORTED_CHAINS[data.chainId]) {
          throw new Error(`Unsupported chain ID: ${data.chainId}`);
        }

        if (!ethers.utils.isAddress(data.token) && data.token !== '0x0000000000000000000000000000000000000000') {
          throw new Error('Invalid token address');
        }

        if (!ethers.utils.isAddress(data.blockradarWallet)) {
          throw new Error('Invalid wallet address');
        }

        try {
          ethers.utils.parseUnits(data.amountInWei, 0); // Validate amountInWei
        } catch {
          throw new Error('Invalid amount');
        }

        setSession(data);
        setTokenInfo(await getTokenInfo(data.token, data.chainId));
      } catch (err) {
        toast.error(`Invalid session: ${err.message}`);
        setSession(null);
      }
    };

    if (ready && authenticated) validateSession();
  }, [ready, authenticated, location.search]);

  useEffect(() => {
    if (wallets.length > 0 && session && !quote) {
      setStatus('Fetching quote...');
      fetchQuote(wallets[0], session)
        .then((quoteData) => {
          setQuote(quoteData);
          setStatus('Quote received');
          toast.success('Quote fetched successfully!');
        })
        .catch((err) => {
          setStatus('Failed to fetch quote');
          toast.error(`Quote failed: ${err.message}`);
        });
    }
  }, [wallets, session, quote]);

  const copyTxHash = () => {
    if (txHash) {
      navigator.clipboard.writeText(txHash);
      toast.info('Transaction hash copied!');
    }
  };

  if (!ready) {
    return (
      <div className="flex items-center justify-center h-screen">
        <FaSpinner className="animate-spin h-12 w-12 text-blue-600" />
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-gray-100">
      <div className="bg-white p-6 rounded-lg shadow-lg w-full max-w-md">
        <div className="flex items-center mb-4">
          <img src="/logo.png" alt="DirectPay Logo" className="h-8 mr-2" />
          <h1 className="text-2xl font-bold text-gray-800">DirectPay</h1>
        </div>
        <ToastContainer position="top-right" autoClose={5000} />
        {!authenticated ? (
          <button
            onClick={login}
            className="w-full bg-blue-600 text-white py-2 rounded hover:bg-blue-700 transition"
          >
            Connect Wallet
          </button>
        ) : (
          <>
            <div className="mb-4 p-4 bg-gray-50 rounded">
              <p className="text-sm">
                <strong>Connected:</strong> {wallets[0]?.address.slice(0, 6)}...{wallets[0]?.address.slice(-4)}
              </p>
              <p className="text-sm">
                <strong>Status:</strong> {status}
              </p>
            </div>
            {session ? (
              <div className="mb-4 p-4 bg-gray-50 rounded">
                <h3 className="text-lg font-semibold mb-2">Sell Details</h3>
                <p>
                  <strong>Amount:</strong> {formatTokenAmount(session.amountInWei, tokenInfo.decimals)} {tokenInfo.symbol}
                </p>
                <p>
                  <strong>Chain:</strong> {SUPPORTED_CHAINS[session.chainId]?.name || 'Unknown'}
                </p>
                <p>
                  <strong>Bank:</strong> {session.bankDetails.bankName} (****{session.bankDetails.accountNumber.slice(-4)})
                </p>
              </div>
            ) : (
              <p className="text-sm text-red-500 mb-4">Unable to load session details. Please try again.</p>
            )}
            {quote && (
              <div className="mb-4 p-4 bg-gray-50 rounded">
                <h3 className="text-lg font-semibold mb-2">Quote</h3>
                <p>
                  <strong>Input:</strong> {formatTokenAmount(quote.details?.currencyIn?.amount, tokenInfo.decimals)} {tokenInfo.symbol}
                </p>
                <p>
                  <strong>Output:</strong> {formatTokenAmount(quote.details?.currencyOut?.amount, 6)} USDC (~${formatUSD(quote.details?.currencyOut?.amountUsd)})
                </p>
                <p>
                  <strong>Fees:</strong> ~${formatUSD((parseFloat(quote.fees?.gas?.amountUsd || 0) + parseFloat(quote.fees?.relayer?.amountUsd || 0)).toFixed(2))}
                </p>
              </div>
            )}
            {txHash && (
              <div className="mb-4 p-4 bg-gray-50 rounded">
                <p>
                  <strong>Tx Hash:</strong>{' '}
                  <a
                    href={`${SUPPORTED_CHAINS[session?.chainId]?.blockExplorer}/tx/${txHash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-600 hover:underline"
                  >
                    {txHash.slice(0, 6)}...{txHash.slice(-4)} <FaExternalLinkAlt className="inline w-3 h-3" />
                  </a>
                  <FaCopy
                    onClick={copyTxHash}
                    className="inline ml-2 cursor-pointer text-gray-600 hover:text-gray-800"
                  />
                </p>
                <QRCode
                  value={`${SUPPORTED_CHAINS[session?.chainId]?.blockExplorer}/tx/${txHash}`}
                  size={100}
                  className="mt-2"
                />
              </div>
            )}
            {quote && session ? (
              <button
                onClick={() => handleSell(wallets[0], session, quote, setLoading, setStatus, setTxHash, session.sessionId)}
                disabled={loading}
                className={`w-full py-2 rounded ${loading ? 'bg-gray-400 cursor-not-allowed' : 'bg-blue-600 text-white hover:bg-blue-700 transition'}`}
              >
                {loading ? <FaSpinner className="animate-spin h-5 w-5 mx-auto" /> : 'Execute Sell'}
              </button>
            ) : (
              <p className="text-sm text-gray-500">{loading ? 'Loading...' : 'Waiting for quote...'}</p>
            )}
            <button
              onClick={logout}
              className="w-full mt-4 bg-gray-300 py-2 rounded hover:bg-gray-400 transition"
            >
              Disconnect
            </button>
          </>
        )}
        <div className="mt-4 text-center">
          <a
            href="https://t.me/maxcswap"
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-600 text-sm hover:underline"
          >
            Need help? Contact @maxcswap
          </a>
        </div>
      </div>
    </div>
  );
};

// App Wrapper
const App = () => (
  <PrivyProvider appId={process.env.REACT_APP_PRIVY_APP_ID}>
    <ConnectWalletApp />
  </PrivyProvider>
);

export default App;
