// client/src/ConnectWalletApp.js
import React, { useEffect, useState } from 'react';
import { PrivyProvider, usePrivy, useWallets } from '@privy-io/react-auth';
import axios from 'axios';
import { ethers } from 'ethers';
import './ConnectWalletApp.css';

const ConnectWalletApp = () => {
  const { ready, authenticated, login, logout } = usePrivy();
  const { wallets } = useWallets();
  const [session, setSession] = useState(null);
  const [quote, setQuote] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const fetchSession = async () => {
      const urlParams = new URLSearchParams(window.location.search);
      const userId = urlParams.get('userId');
      const sessionId = urlParams.get('sessionId');

      if (!userId || !sessionId) {
        setError('Missing userId or sessionId');
        return;
      }

      try {
        const response = await axios.get(`/api/session?userId=${userId}&sessionId=${sessionId}`);
        setSession(response.data);
      } catch (err) {
        setError('Failed to fetch session');
      }
    };

    if (ready && authenticated) {
      fetchSession();
    }
  }, [ready, authenticated]);

  const fetchQuote = async (walletAddress) => {
    if (!session) return;
    setLoading(true);
    try {
      const quoteResponse = await axios.post('https://api.relay.link/quote', {
        user: walletAddress,
        originChainId: session.chainId,
        originCurrency: session.token,
        destinationChainId: 8453, // Base chain
        destinationCurrency: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC on Base
        tradeType: 'EXACT_INPUT',
        recipient: session.blockradarWallet,
        amount: session.amountInWei,
        refundTo: walletAddress
      });
      setQuote(quoteResponse.data);
      setError(null);
    } catch (err) {
      setError(`Failed to fetch quote: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const handleSell = async () => {
    if (!wallets.length || !session || !quote) return;

    const wallet = wallets[0];
    const provider = await wallet.getEthersProvider();
    const signer = provider.getSigner();

    try {
      setLoading(true);
      // Approve token if not native
      if (session.token !== '0x0000000000000000000000000000000000000000') {
        const erc20Abi = ['function approve(address spender, uint256 amount) public returns (bool)'];
        const tokenContract = new ethers.Contract(session.token, erc20Abi, signer);
        const tx = await tokenContract.approve(quote.approvalAddress, session.amountInWei);
        await tx.wait();
      }

      // Execute transaction
      const txResponse = await signer.sendTransaction({
        to: quote.to,
        data: quote.data,
        value: quote.value ? ethers.BigNumber.from(quote.value) : 0
      });
      await txResponse.wait();

      // Notify server of success
      await axios.post('/webhook/sell-completed', {
        userId: new URLSearchParams(window.location.search).get('userId'),
        sessionId: new URLSearchParams(window.location.search).get('sessionId'),
        txHash: txResponse.hash
      });

      setError('Sell completed successfully!');
    } catch (err) {
      setError(`Error during sell: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (wallets.length > 0 && session && !quote) {
      fetchQuote(wallets[0].address);
    }
  }, [wallets, session]);

  if (!ready) return <div>Loading...</div>;

  return (
    <div className="connect-wallet-app">
      <h1>Sell Your Crypto</h1>
      {!authenticated ? (
        <button onClick={login}>Connect Wallet</button>
      ) : (
        <>
          <p>Connected: {wallets[0]?.address}</p>
          {session ? (
            <>
              <p>Amount: {ethers.utils.formatUnits(session.amountInWei, 6)} {session.token === '0x0000000000000000000000000000000000000000' ? 'ETH' : 'Token'}</p>
              <p>To: {session.blockradarWallet}</p>
              {quote ? (
                <>
                  <p>Quote: {ethers.utils.formatUnits(quote.amountOut, 6)} USDC</p>
                  <p>Fees: {ethers.utils.formatEther(quote.feeDetails.totalFee)} ETH</p>
                  <button onClick={handleSell} disabled={loading}>
                    {loading ? 'Processing...' : 'Execute Sell'}
                  </button>
                </>
              ) : (
                <p>{loading ? 'Fetching quote...' : 'Waiting for quote...'}</p>
              )}
            </>
          ) : (
            <p>Fetching session...</p>
          )}
          <button onClick={logout}>Disconnect</button>
        </>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
};

const App = () => (
  <PrivyProvider appId={process.env.REACT_APP_PRIVY_APP_ID} config={{}}>
    <ConnectWalletApp />
  </PrivyProvider>
);

export default App;
