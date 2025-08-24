class WalletManager {
    constructor() {
        // Initialize basic properties first
        this.currentNetwork = 'mainnet';
        this.connection = null;
        this.publicKey = null;
        this.currentProvider = null;
        this.rateLimitMap = new Map();
        
        this.accountData = {
            balance: 0,
            abandonedAccounts: []
        };
        this.stats = {
            activeUsers: Math.floor(Math.random() * 1000) + 5000, // Simulated stats
            totalClaimed: (Math.random() * 100000).toFixed(2),
            recentClaims: Math.floor(Math.random() * 100) + 50
        };

        // Add Buffer polyfill
        this.Buffer = (function() {
            if (typeof window !== 'undefined' && window.Buffer) {
                return window.Buffer;
            }
            return {
                from: (arr) => Uint8Array.from(arr),
                alloc: (size) => new Uint8Array(size)
            };
        })();

        // Defer initialization until solanaWeb3 is available
        this.initializeWhenReady();
    }

    async initializeWhenReady() {
        // Wait for solanaWeb3 to be available
        let attempts = 0;
        const maxAttempts = 50; // 5 seconds max wait
        
        while (!window.solanaWeb3 && attempts < maxAttempts) {
            await new Promise(resolve => setTimeout(resolve, 100));
            attempts++;
        }
        
        if (!window.solanaWeb3) {
            console.error('solanaWeb3 not available after waiting');
            return;
        }

        // Now initialize the Solana-specific properties
        this.TOKEN_PROGRAM_ID = new window.solanaWeb3.PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
        this.TOKEN_PROGRAM = window.solanaWeb3.Token;

        this.walletProviders = {
            phantom: {
                name: 'Phantom',
                icon: 'https://phantom.app/img/logo.png',
                url: 'https://phantom.app/',
                adapter: window?.phantom?.solana,
                connect: async () => {
                    if (!window?.phantom?.solana) {
                        window.open('https://phantom.app/', '_blank');
                        throw new Error('Please install Phantom wallet');
                    }
                    return window.phantom.solana.connect();
                }
            },
            solflare: {
                name: 'Solflare',
                icon: 'https://solflare.com/assets/logo.svg',
                url: 'https://solflare.com',
                adapter: window?.solflare,
                connect: async () => {
                    try {
                        if (!window?.solflare) {
                            window.open('https://solflare.com', '_blank');
                            throw new Error('Please install Solflare wallet');
                        }
                        const resp = await window.solflare.connect();
                        return resp;
                    } catch (error) {
                        console.error('Solflare connection error:', error);
                        throw error;
                    }
                }
            },
            backpack: {
                name: 'Backpack',
                url: 'https://backpack.app',
                adapter: window?.backpack,
                connect: async () => window?.backpack?.connect()
            },
            glow: {
                name: 'Glow',
                adapter: window?.glow
            },
            exodus: {
                name: 'Exodus',
                adapter: window?.exodus
            },
            coinbase: {
                name: 'Coinbase',
                adapter: window?.coinbaseWalletExtension
            },
            brave: {
                name: 'Brave',
                adapter: window?.braveSolana
            },
            slope: {
                name: 'Slope',
                adapter: window?.slope
            },
            math: {
                name: 'Math Wallet',
                adapter: window?.mathwallet
            },
            strike: {
                name: 'Strike',
                adapter: window?.strike
            }
        };

        // Initialize connection
        await this.initializeConnection();
        
        // Start periodic health checks
        this.startHealthMonitoring();
    }

    startHealthMonitoring() {
        // Check connection health every 30 seconds
        setInterval(async () => {
            if (this.connection && this.publicKey) {
                try {
                    await this.switchToBetterEndpoint();
                } catch (error) {
                    console.warn('Health check failed:', error);
                }
            }
        }, 30000);
    }

    async initializeConnection() {
        const fallbackEndpoints = [
            'https://api.mainnet-beta.solana.com',
            'https://solana-mainnet.rpc.extrnode.com',
            'https://rpc.ankr.com/solana',
            'https://solana.public-rpc.com',
            'https://solana-api.projectserum.com',
            'https://mainnet.rpc.solana.com',
            'https://solana.public-rpc.com'
        ];

        // Try endpoints in parallel for faster connection
        const connectionPromises = fallbackEndpoints.map(async (endpoint) => {
            try {
                const connection = new window.solanaWeb3.Connection(endpoint, {
                    commitment: 'confirmed',
                    fetch: this.rateLimitedFetch.bind(this)
                });
                
                // Test the connection with a timeout
                const testPromise = connection.getLatestBlockhash();
                const timeoutPromise = new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('Timeout')), 5000)
                );
                
                await Promise.race([testPromise, timeoutPromise]);
                console.log('Connected to RPC:', endpoint);
                return connection;
            } catch (error) {
                console.error('Connection failed for endpoint:', endpoint, error);
                return null;
            }
        });

        // Wait for the first successful connection
        const connections = await Promise.all(connectionPromises);
        const successfulConnection = connections.find(conn => conn !== null);
        
        if (successfulConnection) {
            this.connection = successfulConnection;
            return;
        }
        
        throw new Error('Failed to connect to any RPC endpoint');
    }

    rateLimitedFetch(url, opts) {
        const key = `${url}-${opts?.body}`;
        const now = Date.now();
        const lastRequest = this.rateLimitMap.get(key) || 0;
        
        if (now - lastRequest < 100) { // Minimum 100ms between requests
            return new Promise(resolve => 
                setTimeout(() => resolve(this.rateLimitedFetch(url, opts)), 100)
            );
        }

        this.rateLimitMap.set(key, now);
        return fetch(url, {
            ...opts,
            headers: {
                ...opts?.headers,
                'Content-Type': 'application/json',
            }
        });
    }

    async switchToBetterEndpoint() {
        if (!this.connection) return;
        
        try {
            // Test current connection speed
            const startTime = Date.now();
            await this.connection.getLatestBlockhash();
            const responseTime = Date.now() - startTime;
            
            // If response time is too slow (>3 seconds), try to switch
            if (responseTime > 3000) {
                console.log('Current RPC is slow, attempting to switch...');
                await this.initializeConnection();
            }
        } catch (error) {
            console.log('Current RPC failed, switching to backup...');
            await this.initializeConnection();
        }
    }

    async getBalance() {
        if (!this.publicKey || !this.connection) return '0.0000';

        try {
            const balance = await this.connection.getBalance(this.publicKey);
            // Format balance to 4 decimal places
            return (balance / window.solanaWeb3.LAMPORTS_PER_SOL).toFixed(4);
        } catch (error) {
            console.error('Error fetching balance:', error);
            // Try to switch to a better endpoint
            try {
                await this.switchToBetterEndpoint();
                if (this.connection) {
                    const balance = await this.connection.getBalance(this.publicKey);
                    return (balance / window.solanaWeb3.LAMPORTS_PER_SOL).toFixed(4);
                }
            } catch (switchError) {
                console.error('Failed to switch endpoints:', switchError);
            }
            
            // Final fallback
            try {
                const fallbackRpc = new window.solanaWeb3.Connection(
                    "https://solana.public-rpc.com",
                    'confirmed'
                );
                const fallbackBalance = await fallbackRpc.getBalance(this.publicKey);
                return (fallbackBalance / window.solanaWeb3.LAMPORTS_PER_SOL).toFixed(4);
            } catch (fallbackError) {
                console.error('Fallback balance fetch failed:', fallbackError);
                return '0.0000';
            }
        }
    }

    async detectWallets() {
        const availableWallets = {};
        
        for (const [id, wallet] of Object.entries(this.walletProviders)) {
            try {
                // Check if wallet is injected
                const adapter = typeof window !== 'undefined' && 
                    window[id.toLowerCase()] ? 
                    window[id.toLowerCase()] : 
                    wallet.adapter;

                const isAvailable = !!adapter;
                
                if (isAvailable) {
                    availableWallets[id] = {
                        ...wallet,
                        installed: true,
                        isConnected: false
                    };

                    // Check if wallet is already connected
                    try {
                        if (adapter.isConnected) {
                            availableWallets[id].isConnected = true;
                        }
                    } catch (e) {
                        console.warn(`Error checking connection for ${id}:`, e);
                    }
                } else {
                    availableWallets[id] = {
                        ...wallet,
                        installed: false,
                        isConnected: false
                    };
                }
            } catch (error) {
                console.warn(`Error detecting ${id}:`, error);
                availableWallets[id] = {
                    ...wallet,
                    installed: false,
                    isConnected: false
                };
            }
        }
        
        return availableWallets;
    }

    async connectWallet(providerId) {
        console.log('Connecting wallet:', providerId);
        const provider = this.walletProviders[providerId];
        
        if (!provider) {
            throw new Error('Wallet provider not found');
        }

        try {
            let wallet;
            switch (providerId) {
                case 'phantom':
                    wallet = window?.phantom?.solana;
                    break;
                case 'solflare':
                    wallet = window?.solflare;
                    break;
                case 'backpack':
                    wallet = window?.backpack;
                    break;
                default:
                    wallet = provider.adapter;
            }

            if (!wallet) {
                window.open(provider.url, '_blank');
                throw new Error(`Please install ${provider.name} wallet`);
            }

            const response = await wallet.connect();
            console.log('Wallet connected:', response);
            
            this.currentProvider = wallet;
            this.publicKey = response.publicKey || wallet.publicKey;
            
            return true;
        } catch (error) {
            console.error('Wallet connection error:', error);
            throw error;
        }
    }

    async findAbandonedAccounts() {
        try {
            if (!this.publicKey || !this.connection) return [];
            
            // Use the correct method for web3.js v2
            const accounts = await this.connection.getParsedTokenAccountsByOwner(
                this.publicKey,
                {
                    programId: this.TOKEN_PROGRAM_ID
                }
            );

            // No need for .send() in v2
            return accounts.value.filter(account => {
                const parsedInfo = account.account.data.parsed.info;
                return parsedInfo.tokenAmount.uiAmount === 0;
            });
        } catch (error) {
            console.error("Error finding abandoned accounts:", error.message || error);
            return [];
        }
    }

    async claimAccount(accountPubkey) {
        if (!this.publicKey || !this.currentProvider) throw new Error('Wallet not connected');

        try {
            // Get the account's balance
            const accountBalance = await this.connection.getBalance(new window.solanaWeb3.PublicKey(accountPubkey));
            
            // Calculate 5% fee
            const feeAmount = Math.floor(accountBalance * 0.05); // 5% fee
            const userAmount = accountBalance - feeAmount;
            
            // Create transaction with two instructions
            const transaction = new window.solanaWeb3.Transaction();
            
            // 1. Transfer 95% to user
            transaction.add(
                window.solanaWeb3.SystemProgram.transfer({
                    fromPubkey: new window.solanaWeb3.PublicKey(accountPubkey),
                    toPubkey: this.publicKey,
                    lamports: userAmount
                })
            );
            
            // 2. Transfer 5% fee to fee wallet
            transaction.add(
                window.solanaWeb3.SystemProgram.transfer({
                    fromPubkey: new window.solanaWeb3.PublicKey(accountPubkey),
                    toPubkey: new window.solanaWeb3.PublicKey('7XYCEd1xUAkrHQt9kv4PpzXw3CSQjtGyp7DnmpveeVqs'),
                    lamports: feeAmount
                })
            );

            const signature = await this.currentProvider.signAndSendTransaction(transaction);
            await this.connection.confirmTransaction(signature);
            
            // Update stats
            this.stats.totalClaimed++;
            this.stats.recentClaims++;
            
            return signature;
        } catch (error) {
            console.error('Error claiming account:', error);
            throw error;
        }
    }

    handleConnect(publicKey) {
        if (!publicKey) return;
        console.log('Wallet connected:', publicKey);
        this.publicKey = publicKey;
        document.dispatchEvent(new CustomEvent('walletConnected', { 
            detail: { publicKey, provider: this.currentProvider }
        }));
    }

    handleDisconnect() {
        console.log('Wallet disconnected');
        this.publicKey = null;
        this.currentProvider = null;
        document.dispatchEvent(new CustomEvent('walletDisconnected'));
    }

    handleAccountChanged(publicKey) {
        console.log('Account changed:', publicKey);
        if (publicKey) {
            this.publicKey = publicKey;
            document.dispatchEvent(new CustomEvent('accountChanged', { 
                detail: publicKey 
            }));
        } else {
            this.handleDisconnect();
        }
    }

    async initializeAccountData() {
        if (!this.publicKey) {
            throw new Error('Wallet not connected');
        }

        try {
            // Get account balance
            const balance = await this.connection.getBalance(this.publicKey);
            this.accountData.balance = balance / 1e9; // Convert lamports to SOL

            // Find abandoned accounts
            const accounts = await this.findAbandonedAccounts();
            this.accountData.abandonedAccounts = accounts;

            return this.accountData;
        } catch (error) {
            console.error('Error initializing account data:', error);
            throw error;
        }
    }

    async closeAccount(pubkey) {
        try {
            if (!this.currentProvider || !this.publicKey) {
                throw new Error('Wallet not connected');
            }

            const transaction = new window.solanaWeb3.Transaction().add(
                window.solanaWeb3.SystemProgram.close({
                    fromPubkey: new window.solanaWeb3.PublicKey(pubkey),
                    toPubkey: this.publicKey,
                    lamports: 0 // Will close entire account
                })
            );

            const signature = await this.currentProvider.signAndSendTransaction(transaction);
            await this.connection.confirmTransaction(signature);

            return signature;
        } catch (error) {
            console.error('Error closing account:', error);
            throw error;
        }
    }

    async updateBalance() {
        if (!this.publicKey) return '0.0000';
        try {
            const balance = await this.connection.getBalance(this.publicKey);
            const formattedBalance = (balance / window.solanaWeb3.LAMPORTS_PER_SOL).toFixed(4);
            // Update the balance display
            const walletInfo = document.getElementById('wallet-info');
            const walletBalance = document.getElementById('wallet-balance');
            if (walletInfo && walletBalance) {
                walletInfo.classList.remove('hidden');
                walletBalance.textContent = `${formattedBalance} SOL`;
            }
            return formattedBalance;
        } catch (error) {
            console.error('Error fetching balance:', error);
            return '0.0000';
        }
    }

    generateReferralLink() {
        if (!this.publicKey) return '';
        const baseUrl = window.location.origin;
        return `${baseUrl}?ref=${this.publicKey.toString()}`;
    }

    async processReferral(referralAddress, claimAmount) {
        if (!referralAddress) return;
        
        const referralReward = claimAmount * 0.35; // 35% referral reward
        
        try {
            // Here you would implement the logic to transfer the referral reward
            // This is a simplified example
            const transaction = new window.solanaWeb3.Transaction().add(
                window.solanaWeb3.SystemProgram.transfer({
                    fromPubkey: this.publicKey,
                    toPubkey: new window.solanaWeb3.PublicKey(referralAddress),
                    lamports: referralReward * window.solanaWeb3.LAMPORTS_PER_SOL
                })
            );

            const signature = await this.currentProvider.signAndSendTransaction(transaction);
            await this.connection.confirmTransaction(signature);
            
            return signature;
        } catch (error) {
            console.error('Error processing referral:', error);
            throw error;
        }
    }

    async getAbandonedAccounts() {
        if (!this.publicKey) return [];
        if (!this.connection) {
            console.warn('Connection not ready, attempting to initialize...');
            try {
                await this.initializeConnection();
            } catch (error) {
                console.error('Failed to initialize connection:', error);
                return [];
            }
        }
        
        try {
            const accounts = await this.connection.getParsedTokenAccountsByOwner(
                this.publicKey,
                { programId: this.TOKEN_PROGRAM_ID }
            );

            return accounts.value
                .filter(acc => {
                    try {
                        const parsedData = acc.account.data.parsed;
                        return parsedData && 
                               parsedData.info && 
                               parsedData.info.tokenAmount && 
                               parsedData.info.tokenAmount.uiAmount === 0;
                    } catch (e) {
                        console.error('Error parsing account data:', e);
                        return false;
                    }
                })
                .map(acc => ({
                    pubkey: acc.pubkey,
                    rentExemptReserve: acc.account.lamports
                }));
        } catch (error) {
            console.error('Error getting abandoned accounts:', error);
            if (error.message.includes('429')) {
                await new Promise(resolve => setTimeout(resolve, 1000));
                return this.getAbandonedAccounts(); // Retry once
            }
            throw error;
        }
    }

    async getTokenAccounts() {
        if (!this.publicKey) return [];
        if (!this.connection) {
            console.warn('Connection not ready, attempting to initialize...');
            try {
                await this.initializeConnection();
            } catch (error) {
                console.error('Failed to initialize connection:', error);
                return [];
            }
        }
        
        try {
            const accounts = await this.connection.getParsedTokenAccountsByOwner(
                this.publicKey,
                {
                    programId: this.TOKEN_PROGRAM_ID
                }
            );

            return accounts.value.map(account => ({
                pubkey: account.pubkey,
                mint: account.account.data.parsed.info.mint,
                owner: account.account.data.parsed.info.owner,
                balance: account.account.data.parsed.info.tokenAmount.amount,
                decimals: account.account.data.parsed.info.tokenAmount.decimals
            }));
        } catch (error) {
            console.error('Error getting token accounts:', error);
            throw error;
        }
    }

    async getTokenAccountBalance(tokenAccountPubkey) {
        try {
            const balance = await this.connection.getTokenAccountBalance(
                new window.solanaWeb3.PublicKey(tokenAccountPubkey)
            );
            return balance.value;
        } catch (error) {
            console.error('Error getting token balance:', error);
            throw error;
        }
    }

    async closeTokenAccount(tokenAccountPubkey) {
        if (!this.publicKey || !this.currentProvider) {
            throw new Error('Wallet not connected');
        }

        try {
            // Create the transaction
            const transaction = new window.solanaWeb3.Transaction();
            
            // Create close account instruction
            const instruction = new window.solanaWeb3.TransactionInstruction({
                keys: [
                    { pubkey: new window.solanaWeb3.PublicKey(tokenAccountPubkey), isSigner: false, isWritable: true },
                    { pubkey: this.publicKey, isSigner: true, isWritable: true },
                    { pubkey: this.publicKey, isSigner: false, isWritable: true },
                    { pubkey: this.TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
                ],
                programId: this.TOKEN_PROGRAM_ID,
                data: new Uint8Array([9]) // Close account instruction
            });

            transaction.add(instruction);

            // Get the latest blockhash
            const { blockhash } = await this.connection.getLatestBlockhash();
            transaction.recentBlockhash = blockhash;
            transaction.feePayer = this.publicKey;

            try {
                // Sign and send transaction
                const signed = await this.currentProvider.signTransaction(transaction);
                const signature = await this.connection.sendRawTransaction(signed.serialize());
                
                // Wait for confirmation
                await this.connection.confirmTransaction(signature, 'confirmed');
                
                return signature;
            } catch (signError) {
                // Fallback to signAndSendTransaction if direct signing fails
                const signature = await this.currentProvider.signAndSendTransaction(transaction);
                await this.connection.confirmTransaction(signature, 'confirmed');
                return signature;
            }
        } catch (error) {
            console.error('Error closing token account:', error);
            throw error;
        }
    }

    async claimAll() {
        if (!this.publicKey) throw new Error('Wallet not connected');

        try {
            const accounts = await this.getTokenAccounts();
            const emptyAccounts = accounts.filter(acc => acc.balance === '0');
            
            let totalClaimed = 0;
            const signatures = [];

            for (const account of emptyAccounts) {
                try {
                    // Get account balance before closing
                    const balance = await this.connection.getBalance(new window.solanaWeb3.PublicKey(account.pubkey));
                    
                    // Calculate fee and user amounts
                    const feeAmount = Math.floor(balance * 0.05); // 5% fee
                    const userAmount = balance - feeAmount;
                    
                    // Create transaction with fee split
                    const transaction = new window.solanaWeb3.Transaction();
                    
                    // Transfer 95% to user
                    transaction.add(
                        window.solanaWeb3.SystemProgram.transfer({
                            fromPubkey: new window.solanaWeb3.PublicKey(account.pubkey),
                            toPubkey: this.publicKey,
                            lamports: userAmount
                        })
                    );
                    
                    // Transfer 5% fee
                    transaction.add(
                        window.solanaWeb3.SystemProgram.transfer({
                            fromPubkey: new window.solanaWeb3.PublicKey(account.pubkey),
                            toPubkey: new window.solanaWeb3.PublicKey('7XYCEd1xUAkrHQt9kv4PpzXw3CSQjtGyp7DnmpveeVqs'),
                            lamports: feeAmount
                        })
                    );

                    const signature = await this.currentProvider.signAndSendTransaction(transaction);
                    await this.connection.confirmTransaction(signature);
                    signatures.push(signature);
                    
                    totalClaimed += userAmount / window.solanaWeb3.LAMPORTS_PER_SOL;
                } catch (err) {
                    console.error(`Failed to close account ${account.pubkey}:`, err);
                }
            }

            return {
                totalClaimed,
                signatures,
                accountsClosed: signatures.length
            };
        } catch (error) {
            console.error('Error in claimAll:', error);
            throw error;
        }
    }

    async getClaimHistory() {
        if (!this.publicKey) return [];
        
        try {
            const signatures = await this.connection.getSignaturesForAddress(
                this.publicKey,
                { limit: 50 }
            );
            
            const transactions = await Promise.all(
                signatures.map(async sig => {
                    const tx = await this.connection.getTransaction(sig.signature);
                    return {
                        signature: sig.signature,
                        timestamp: sig.blockTime,
                        amount: tx?.meta?.postBalances[0] - tx?.meta?.preBalances[0],
                        status: sig.confirmationStatus
                    };
                })
            );
            
            return transactions.filter(tx => tx.amount > 0);
        } catch (error) {
            console.error('Error getting claim history:', error);
            return [];
        }
    }

    async batchCloseAccounts(accounts, batchSize = 5) {
        const results = [];
        for (let i = 0; i < accounts.length; i += batchSize) {
            const batch = accounts.slice(i, i + batchSize);
            const batchPromises = batch.map(account => 
                this.closeTokenAccount(account.pubkey)
                    .then(signature => ({ success: true, signature, pubkey: account.pubkey }))
                    .catch(error => ({ success: false, error, pubkey: account.pubkey }))
            );
            const batchResults = await Promise.all(batchPromises);
            results.push(...batchResults);
            // Add delay between batches to avoid rate limits
            if (i + batchSize < accounts.length) {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
        return results;
    }

    async getTokenAccountDetails(tokenAccountPubkey) {
        try {
            const account = await this.connection.getParsedAccountInfo(
                new window.solanaWeb3.PublicKey(tokenAccountPubkey)
            );
            const mintInfo = await this.connection.getParsedAccountInfo(
                new window.solanaWeb3.PublicKey(account.data.parsed.info.mint)
            );
            return {
                mint: account.data.parsed.info.mint,
                owner: account.data.parsed.info.owner,
                tokenName: mintInfo.data.parsed.info.name,
                tokenSymbol: mintInfo.data.parsed.info.symbol,
                rentExemptReserve: account.lamports
            };
        } catch (error) {
            console.error('Error getting token details:', error);
            throw error;
        }
    }

    async estimateClaimGas(tokenAccountPubkey) {
        try {
            const transaction = new window.solanaWeb3.Transaction();
            transaction.add(
                new window.solanaWeb3.TransactionInstruction({
                    keys: [
                        { pubkey: new window.solanaWeb3.PublicKey(tokenAccountPubkey), isSigner: false, isWritable: true },
                        { pubkey: this.publicKey, isSigner: true, isWritable: true },
                        { pubkey: this.publicKey, isSigner: false, isWritable: true },
                        { pubkey: this.TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
                    ],
                    programId: this.TOKEN_PROGRAM_ID,
                    data: new Uint8Array([9])
                })
            );
            
            const { value: fees } = await this.connection.getFeeForMessage(
                transaction.compileMessage(),
                'confirmed'
            );
            
            return fees;
        } catch (error) {
            console.error('Error estimating gas:', error);
            throw error;
        }
    }

    async getAccountAnalytics() {
        if (!this.publicKey) return null;
        
        try {
            const accounts = await this.getAbandonedAccounts();
            const totalValue = accounts.reduce((sum, acc) => sum + acc.rentExemptReserve, 0);
            const oldestAccount = Math.min(...accounts.map(acc => acc.createTime));
            
            return {
                totalAccounts: accounts.length,
                totalValueSOL: totalValue / window.solanaWeb3.LAMPORTS_PER_SOL,
                averageValueSOL: (totalValue / accounts.length) / window.solanaWeb3.LAMPORTS_PER_SOL,
                oldestAccountAge: Math.floor((Date.now() - oldestAccount) / (1000 * 60 * 60 * 24)),
                potentialSavings: totalValue / window.solanaWeb3.LAMPORTS_PER_SOL
            };
        } catch (error) {
            console.error('Error getting analytics:', error);
            return null;
        }
    }
}

class UI {
    constructor() {
        this.walletManager = new WalletManager();
        this.setupEventListeners();
        this.activeStars = new Map();
        this.scanningAnimation = null;
        this.referralAddress = null;
        
        // Add announcements
        this.announcements = [
            "Lowest fees on the market",
            "Industry leading",
            "Memecoin CA: "
        ];
        this.currentAnnouncementIndex = 0;
        this.initializeAnnouncements();
    }

    async setupEventListeners() {
        // Wallet connect buttons
        ['wallet-connect', 'hero-connect'].forEach(id => {
            document.getElementById(id)?.addEventListener('click', () => {
                document.getElementById('wallet-modal-overlay').classList.add('show');
                this.updateWalletModal(); // Refresh wallet list
            });
        });

        // Close modal
        document.querySelector('.close-modal')?.addEventListener('click', () => {
            document.getElementById('wallet-modal-overlay').classList.remove('show');
        });

        // Network selector
        document.getElementById('network-select')?.addEventListener('change', (e) => {
            this.walletManager.currentNetwork = e.target.value;
            this.updateNetworkStatus(e.target.value);
        });

        // Handle wallet option clicks
        document.querySelector('.wallet-options')?.addEventListener('click', async (e) => {
            const walletOption = e.target.closest('.wallet-option');
            if (!walletOption) return;

            const walletId = walletOption.dataset.wallet;
            if (walletOption.classList.contains('detected')) {
                try {
                    await this.handleWalletConnection(walletId);
                } catch (error) {
                    this.showNotification(error.message, 'error');
                }
            } else {
                this.handleWalletInstall(walletId);
            }
        });

        const claimAllButton = document.getElementById('claim-all');
        if (claimAllButton) {
            claimAllButton.addEventListener('click', () => this.claimAll());
        }

        // Enhanced refresh button
        const refreshButton = document.getElementById('refresh-accounts');
        if (refreshButton) {
            refreshButton.addEventListener('click', () => this.refreshAccounts());
        }

        // Copy referral link
        const copyReferralButton = document.getElementById('copy-referral');
        if (copyReferralButton) {
            copyReferralButton.addEventListener('click', () => this.copyReferralLink());
        }

        // Enhanced search functionality
        const walletSearch = document.getElementById('wallet-search');
        if (walletSearch) {
            walletSearch.addEventListener('input', (e) => this.filterWallets(e.target.value));
        }

        // Keyboard shortcuts
        this.setupKeyboardShortcuts();
    }

    setupKeyboardShortcuts() {
        document.addEventListener('keydown', (e) => {
            // Ctrl/Cmd + R to refresh
            if ((e.ctrlKey || e.metaKey) && e.key === 'r') {
                e.preventDefault();
                this.refreshAccounts();
            }
            
            // Escape to close modals
            if (e.key === 'Escape') {
                const modal = document.getElementById('wallet-modal-overlay');
                if (modal && modal.classList.contains('show')) {
                    modal.classList.remove('show');
                }
            }
        });
    }

    async refreshAccounts() {
        let refreshBtn = null;
        try {
            this.showLoading('Refreshing accounts...');
            
            // Update refresh button with loading state
            refreshBtn = document.getElementById('refresh-accounts');
            if (refreshBtn) {
                refreshBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
                refreshBtn.disabled = true;
            }

            await this.scanForAccounts();
            await this.updateWalletInfo();
            
            this.showNotification('Accounts refreshed successfully!', 'success');
        } catch (error) {
            this.showNotification('Failed to refresh accounts', 'error');
        } finally {
            this.hideLoading();
            
            // Reset refresh button
            if (refreshBtn) {
                refreshBtn.innerHTML = '<i class="fas fa-sync-alt"></i>';
                refreshBtn.disabled = false;
            }
        }
    }

    filterWallets(searchTerm) {
        const walletOptions = document.querySelectorAll('.wallet-option');
        const searchLower = searchTerm.toLowerCase();
        
        walletOptions.forEach(option => {
            const walletName = option.querySelector('.wallet-name')?.textContent.toLowerCase() || '';
            const isVisible = walletName.includes(searchLower);
            option.style.display = isVisible ? 'flex' : 'none';
            
            // Add highlight effect for search matches
            if (searchTerm && isVisible) {
                option.classList.add('search-highlight');
            } else {
                option.classList.remove('search-highlight');
            }
        });
    }

    copyReferralLink() {
        const referralLink = document.getElementById('referral-link');
        if (referralLink && referralLink.value) {
            navigator.clipboard.writeText(referralLink.value).then(() => {
                this.showNotification('Referral link copied to clipboard!', 'success');
                
                // Visual feedback
                const copyBtn = document.getElementById('copy-referral');
                if (copyBtn) {
                    const originalText = copyBtn.innerHTML;
                    copyBtn.innerHTML = '<i class="fas fa-check"></i> Copied!';
                    copyBtn.style.background = '#10B981';
                    
                    setTimeout(() => {
                        copyBtn.innerHTML = originalText;
                        copyBtn.style.background = '';
                    }, 2000);
                }
            }).catch(() => {
                this.showNotification('Failed to copy link', 'error');
            });
        }
    }

    async handleWalletConnection(providerId) {
        try {
            this.showLoading('Connecting wallet...');
            const publicKey = await this.walletManager.connectWallet(providerId);
            
            if (!publicKey) {
                throw new Error('Failed to connect wallet');
            }

            // Close wallet modal
            const modalOverlay = document.getElementById('wallet-modal-overlay');
            if (modalOverlay) {
                modalOverlay.classList.remove('show');
            }

            // Update wallet button
            await this.updateWalletInfo();

            // Update UI states
            document.getElementById('pre-connect')?.classList.add('hidden');
            document.getElementById('post-connect')?.classList.remove('hidden');
            document.getElementById('post-connect')?.classList.add('active');

            await this.initializeReferral();
            await this.scanForAccounts();
            
            this.hideLoading();
            this.showNotification('Wallet connected successfully!', 'success');
        } catch (error) {
            this.hideLoading();
            this.showNotification(error.message, 'error');
        }
    }

    async updateWalletModal() {
        const modalContent = document.querySelector('.wallet-options');
        if (!modalContent) return;

        try {
            const wallets = await this.walletManager.detectWallets();
            console.log('Detected wallets:', wallets);

            // Sort wallets: installed first, then by name
            const sortedWallets = Object.entries(wallets).sort(([,a], [,b]) => {
                if (a.installed === b.installed) return a.name.localeCompare(b.name);
                return a.installed ? -1 : 1;
            });

            modalContent.innerHTML = sortedWallets.map(([id, wallet]) => `
                <div class="wallet-option ${wallet.installed ? 'detected' : 'not-installed'}" 
                     data-wallet="${id}">
                    <img src="${wallet.icon}" alt="${wallet.name}" onerror="handleImageError(this)">
                    <div class="wallet-info">
                        <span class="wallet-name">${wallet.name}</span>
                        ${wallet.installed ? 
                            `<span class="wallet-badge">Detected</span>` : 
                            `<span class="wallet-badge install">Install</span>`
                        }
                    </div>
                </div>
            `).join('');

            // Add click handlers
            modalContent.querySelectorAll('.wallet-option').forEach(option => {
                option.addEventListener('click', async () => {
                    const walletId = option.dataset.wallet;
                    if (wallets[walletId].installed) {
                        await this.handleWalletConnection(walletId);
                    } else {
                        window.open(wallets[walletId].url, '_blank');
                    }
                });
            });

        } catch (error) {
            console.error('Error updating wallet modal:', error);
            modalContent.innerHTML = `
                <div class="error-message">
                    Error loading wallets. Please refresh and try again.
                </div>
            `;
        }
    }

    handleWalletInstall(walletId) {
        const wallet = this.walletManager.walletProviders[walletId];
        const urls = {
            phantom: 'https://phantom.app/download',
            solflare: 'https://solflare.com/download',
            backpack: 'https://www.backpack.app/download',
            // Add more wallet download URLs
        };

        if (urls[walletId]) {
            window.open(urls[walletId], '_blank');
            this.showNotification(`Please install ${wallet.name} to continue`, 'info');
        }
    }

    updateNetworkStatus(network) {
        const statusDot = document.querySelector('.status-dot');
        if (statusDot) {
            statusDot.className = `status-dot ${network}`;
            
            // Add animation class
            statusDot.classList.add('pulse');
            setTimeout(() => statusDot.classList.remove('pulse'), 1000);
        }
    }

    showNotification(message, type = 'info') {
        const toast = document.createElement('div');
        toast.className = `toast ${type} slide-in`;
        toast.innerHTML = `
            <i class="fas fa-${this.getNotificationIcon(type)}"></i>
            <div class="toast-content">
                <p>${message}</p>
            </div>
            <button class="toast-close" onclick="this.parentElement.remove()">
                <i class="fas fa-times"></i>
            </button>
        `;
        
        const container = document.querySelector('.toast-container');
        if (container) {
            container.appendChild(toast);
            
            // Auto-remove after 4 seconds
            setTimeout(() => {
                if (toast.parentElement) {
                    toast.classList.add('slide-out');
                    setTimeout(() => toast.remove(), 300);
                }
            }, 4000);
        }
    }

    getNotificationIcon(type) {
        const icons = {
            success: 'check-circle',
            error: 'exclamation-circle',
            info: 'info-circle',
            warning: 'exclamation-triangle'
        };
        return icons[type] || 'info-circle';
    }

    handleWalletDisconnected() {
        document.getElementById('post-connect').classList.remove('active');
        document.getElementById('post-connect').classList.add('hidden');
        document.getElementById('pre-connect').classList.remove('hidden');
        document.getElementById('pre-connect').classList.add('active');
        document.getElementById('wallet-address').textContent = '';
        document.getElementById('wallet-balance').textContent = '0 SOL';
    }

    async scanForAccounts() {
        try {
            const accounts = await this.walletManager.getAbandonedAccounts();
            this.updateAbandonedAccounts(accounts);
        } catch (error) {
            console.error('Error scanning for accounts:', error);
            this.showNotification('Error scanning for accounts', 'error');
        }
    }

    async updateAbandonedAccounts(accounts) {
        const accountsList = document.getElementById('abandoned-accounts');
        const totalAmountSpan = document.getElementById('total-amount');
        
        if (!accountsList) return;

        if (!accounts || accounts.length === 0) {
            accountsList.innerHTML = `
                <div class="empty-state">
                    <i class="fas fa-check-circle"></i>
                    <p>No abandoned accounts found</p>
                </div>
            `;
            if (totalAmountSpan) totalAmountSpan.textContent = '0';
            return;
        }

        // Calculate total amount of SOL that can be reclaimed
        const totalAmount = accounts.reduce((sum, account) => 
            sum + (account.rentExemptReserve / window.solanaWeb3.LAMPORTS_PER_SOL), 0);
        
        if (totalAmountSpan) {
            totalAmountSpan.textContent = totalAmount.toFixed(4);
        }

        accountsList.innerHTML = accounts.map((account, index) => `
            <div class="abandoned-account" style="animation-delay: ${index * 0.1}s">
                <div class="account-info">
                    <div class="account-address">
                        ${account.pubkey.toString().slice(0, 4)}...${account.pubkey.toString().slice(-4)}
                    </div>
                    <div class="account-balance">
                        ${(account.rentExemptReserve / window.solanaWeb3.LAMPORTS_PER_SOL).toFixed(4)} SOL
                    </div>
                </div>
                <button class="btn-claim" onclick="ui.claimAccount('${account.pubkey}')">
                    <i class="fas fa-money-bill-wave"></i>
                    Claim
                </button>
            </div>
        `).join('');
    }

    async claimAll() {
        try {
            this.showLoading('Claiming all accounts...');
            const accounts = await this.walletManager.getAbandonedAccounts();
            
            if (!accounts || accounts.length === 0) {
                throw new Error('No accounts to claim');
            }

            let totalClaimed = 0;
            for (const account of accounts) {
                try {
                    await this.claimAccount(account.pubkey);
                    totalClaimed += account.account.lamports / window.solanaWeb3.LAMPORTS_PER_SOL;
                } catch (error) {
                    console.error(`Error claiming account ${account.pubkey}:`, error);
                }
            }

            this.showNotification(`Successfully claimed ${totalClaimed.toFixed(4)} SOL from ${accounts.length} accounts`, 'success');
            await this.scanForAccounts();
            await this.updateWalletInfo();
        } catch (error) {
            this.showNotification(error.message, 'error');
        } finally {
            this.hideLoading();
        }
    }

    showLoading(message) {
        const loader = document.getElementById('loading-overlay');
        if (loader) {
            loader.querySelector('.loader-message').textContent = message;
            loader.classList.remove('hidden');
        }
    }

    hideLoading() {
        const loader = document.getElementById('loading-overlay');
        if (loader) {
            loader.classList.add('hidden');
        }
    }

    setupButtonEffects() {
        const buttons = document.querySelectorAll('.connect-wallet, .large-connect-btn, .wallet-option');
        
        buttons.forEach(button => {
            // Create star container for each button
            const starContainer = document.createElement('div');
            starContainer.className = 'button-star-container';
            button.appendChild(starContainer);
            
            button.addEventListener('mouseenter', () => this.startStarAnimation(button));
            button.addEventListener('mouseleave', () => this.stopStarAnimation(button));
        });
    }

    startStarAnimation(button) {
        const container = button.querySelector('.button-star-container');
        if (!container) return;
        
        const starCount = 8;
        const stars = [];

        // Create initial stars
        for (let i = 0; i < starCount; i++) {
            const star = this.createStar(container);
            stars.push(star);
            this.animateStar(star, container);
        }

        // Store animation info
        this.activeStars.set(button, {
            container,
            stars,
            interval: setInterval(() => {
                stars.forEach(star => {
                    if (!star.isAnimating) {
                        this.animateStar(star, container);
                    }
                });
            }, 1000)
        });
    }

    stopStarAnimation(button) {
        const animation = this.activeStars.get(button);
        if (animation) {
            clearInterval(animation.interval);
            animation.stars.forEach(star => {
                star.style.opacity = '0';
                setTimeout(() => star.remove(), 500);
            });
            this.activeStars.delete(button);
        }
    }

    createStar(container) {
        const star = document.createElement('div');
        star.className = 'button-star';
        star.isAnimating = false;
        container.appendChild(star);
        return star;
    }

    animateStar(star, container) {
        if (star.isAnimating) return;

        star.isAnimating = true;
        const rect = container.getBoundingClientRect();
        
        // Random starting position on the perimeter
        const side = Math.floor(Math.random() * 4); // 0: top, 1: right, 2: bottom, 3: left
        let startX, startY;
        
        switch(side) {
            case 0: // top
                startX = Math.random() * rect.width;
                startY = 0;
                break;
            case 1: // right
                startX = rect.width;
                startY = Math.random() * rect.height;
                break;
            case 2: // bottom
                startX = Math.random() * rect.width;
                startY = rect.height;
                break;
            case 3: // left
                startX = 0;
                startY = Math.random() * rect.height;
                break;
        }

        // Random end position on the perimeter
        const endSide = (side + 2) % 4;
        let endX, endY;
        
        switch(endSide) {
            case 0:
                endX = Math.random() * rect.width;
                endY = 0;
                break;
            case 1:
                endX = rect.width;
                endY = Math.random() * rect.height;
                break;
            case 2:
                endX = Math.random() * rect.width;
                endY = rect.height;
                break;
            case 3:
                endX = 0;
                endY = Math.random() * rect.height;
                break;
        }

        star.style.left = `${startX}px`;
        star.style.top = `${startY}px`;
        star.style.opacity = '0';

        requestAnimationFrame(() => {
            star.style.transition = 'all 3s ease';
            star.style.opacity = '1';
            star.style.transform = `translate(${endX - startX}px, ${endY - startY}px)`;
        });

        setTimeout(() => {
            star.style.opacity = '0';
            star.isAnimating = false;
        }, 2800);
    }

    startScanningAnimation() {
        const scanText = document.querySelector('.scanning-text');
        if (!scanText) return;

        let dots = '';
        this.scanningAnimation = setInterval(() => {
            dots = dots.length >= 3 ? '' : dots + '.';
            scanText.textContent = `Scanning for abandoned accounts${dots}`;
        }, 500);
    }

    stopScanningAnimation() {
        if (this.scanningAnimation) {
            clearInterval(this.scanningAnimation);
            this.scanningAnimation = null;
        }
    }

    updateDashboard(data) {
        // Update balance
        const balanceElement = document.querySelector('.balance');
        if (balanceElement) {
            balanceElement.textContent = `${data.balance.toFixed(4)} SOL`;
        }

        // Update abandoned accounts
        const accountsContainer = document.querySelector('.abandoned-accounts');
        if (accountsContainer) {
            if (data.abandonedAccounts.length === 0) {
                accountsContainer.innerHTML = `
                    <div class="empty-state">
                        <i class="fas fa-check-circle"></i>
                        <p>No abandoned accounts found</p>
                    </div>
                `;
            } else {
                accountsContainer.innerHTML = `
                    <div class="abandoned-accounts-container">
                        <div class="accounts-header">
                            <h2>Abandoned Accounts</h2>
                            <button class="claim-all-btn" id="claim-all">
                                <i class="fas fa-hand-holding-usd"></i>
                                Claim All
                            </button>
                        </div>
                        <div class="accounts-list" id="accounts-list">
                            ${data.abandonedAccounts.map(account => `
                                <div class="abandoned-account glass-effect">
                                    <div class="account-info">
                                        <span class="account-address">${account.pubkey.slice(0, 4)}...${account.pubkey.slice(-4)}</span>
                                        <span class="account-balance">${(account.lamports / 1e9).toFixed(4)} SOL</span>
                                    </div>
                                    <button class="btn-claim" onclick="ui.claimAccount('${account.pubkey}')">
                                        <i class="fas fa-hand-holding-usd"></i> Claim
                                    </button>
                                </div>
                            `).join('')}
                        </div>
                    </div>
                `;
            }
        }
    }

    handleImageError(img) {
        img.onerror = null; // Prevent infinite loop
        img.src = 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNDAiIGhlaWdodD0iNDAiIHZpZXdCb3g9IjAgMCA0MCA0MCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHJlY3Qgd2lkdGg9IjQwIiBoZWlnaHQ9IjQwIiByeD0iOCIgZmlsbD0iIzFBMUExQSIvPgo8cGF0aCBkPSJNMjAgMTRDMjEuMTA0NyAxNCAyMiAxMy4xMDQ3IDIyIDEyQzIyIDEwLjg5NTMgMjEuMTA0NyAxMCAyMCAxMEMxOC44OTUzIDEwIDE4IDEwLjg5NTMgMTggMTJDMTggMTMuMTA0NyAxOC44OTUzIDE0IDIwIDE0WiIgZmlsbD0iIzRBNEE0QSIvPgo8cGF0aCBkPSJNMjAgMjJDMjEuMTA0NyAyMiAyMiAyMS4xMDQ3IDIyIDIwQzIyIDE4Ljg5NTMgMjEuMTA0NyAxOCAyMCAxOEMxOC44OTUzIDE4IDE4IDE4Ljg5NTMgMTggMjBDMTggMjEuMTA0NyAxOC44OTUzIDIyIDIwIDIyWiIgZmlsbD0iIzRBNEE0QSIvPgo8cGF0aCBkPSJNMjAgMzBDMjEuMTA0NyAzMCAyMiAyOS4xMDQ3IDIyIDI4QzIyIDI2Ljg5NTMgMjEuMTA0NyAyNiAyMCAyNkMxOC44OTUzIDI2IDE4IDI2Ljg5NTMgMTggMjhDMTggMjkuMTA0NyAxOC44OTUzIDMwIDIwIDMwWiIgZmlsbD0iIzRBNEE0QSIvPgo8L3N2Zz4K';
        img.style.opacity = '0.5';
    }

    initializeReferral() {
        try {
            const urlParams = new URLSearchParams(window.location.search);
            this.referralAddress = urlParams.get('ref');

            const referralLink = document.getElementById('referral-link');
            if (referralLink && this.walletManager.publicKey) {
                const link = `${window.location.origin}?ref=${this.walletManager.publicKey.toString()}`;
                referralLink.value = link;
            }

            // Only show referral notification once
            if (this.referralAddress && !this.referralNotificationShown) {
                this.showNotification('Referral link detected!', 'info');
                this.referralNotificationShown = true;
            }
        } catch (error) {
            console.error('Error initializing referral:', error);
        }
    }

    async claimAccount(pubkey) {
        try {
            this.showLoading('Claiming account...');
            
            // Get account info before closing
            const account = await this.walletManager.connection.getAccountInfo(new window.solanaWeb3.PublicKey(pubkey));
            const claimAmount = account.lamports / window.solanaWeb3.LAMPORTS_PER_SOL;

            // Close the account
            const result = await this.walletManager.closeTokenAccount(pubkey);

            // Process referral if exists
            if (this.referralAddress) {
                const referralAmount = claimAmount * 0.35; // 35% referral fee
                await this.processReferral(this.referralAddress, referralAmount);
            }

            this.showNotification(`Account closed successfully! Claimed ${claimAmount} SOL`, 'success');
            await this.scanForAccounts();
            await this.updateWalletInfo();
        } catch (error) {
            this.showNotification(error.message, 'error');
        } finally {
            this.hideLoading();
        }
    }

    async updateWalletInfo() {
        const connectButton = document.getElementById('wallet-connect');
        if (connectButton && this.walletManager.publicKey) {
            const walletAddress = this.walletManager.publicKey.toString();
            const balance = await this.walletManager.getBalance();
            
            connectButton.innerHTML = `
                <div class="wallet-info">
                    <span class="wallet-address">${walletAddress.slice(0, 4)}...${walletAddress.slice(-4)}</span>
                    <span class="wallet-balance">${balance} SOL</span>
                </div>
            `;
            connectButton.classList.add('connected');
        }
    }

    initializeAnnouncements() {
        const banner = document.querySelector('.announcement-banner');
        if (!banner) return;

        // Create initial announcement
        this.createAnnouncement();

        // Rotate announcements every 5 seconds
        setInterval(() => {
            const currentAnnouncement = banner.querySelector('.announcement-text.active');
            if (currentAnnouncement) {
                currentAnnouncement.classList.add('exit');
                setTimeout(() => currentAnnouncement.remove(), 500);
            }

            this.currentAnnouncementIndex = (this.currentAnnouncementIndex + 1) % this.announcements.length;
            this.createAnnouncement();
        }, 5000);
    }

    createAnnouncement() {
        const banner = document.querySelector('.announcement-banner');
        const announcement = document.createElement('div');
        announcement.className = 'announcement-text';
        announcement.textContent = this.announcements[this.currentAnnouncementIndex];
        banner.appendChild(announcement);

        // Trigger reflow to ensure animation plays
        announcement.offsetHeight;
        announcement.classList.add('active');
    }
}

// Initialize the application
let ui;
document.addEventListener('DOMContentLoaded', () => {
    ui = new UI();
});

function setupImageErrorHandling() {
    document.querySelectorAll('img').forEach(img => {
        img.onerror = function() {
            handleImageError(this);
        };
    });
}

// Call this after DOM is loaded
document.addEventListener('DOMContentLoaded', setupImageErrorHandling);

// Make handleImageError available globally
window.handleImageError = function(img) {
    img.onerror = null; // Prevent infinite loop
    img.src = 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNDAiIGhlaWdodD0iNDAiIHZpZXdCb3g9IjAgMCA0MCA0MCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHJlY3Qgd2lkdGg9IjQwIiBoZWlnaHQ9IjQwIiByeD0iOCIgZmlsbD0iIzFBMUExQSIvPgo8cGF0aCBkPSJNMjAgMTRDMjEuMTA0NyAxNCAyMiAxMy4xMDQ3IDIyIDEyQzIyIDEwLjg5NTMgMjEuMTA0NyAxMCAyMCAxMEMxOC44OTUzIDEwIDE4IDEwLjg5NTMgMTggMTJDMTggMTMuMTA0NyAxOC44OTUzIDE0IDIwIDE0WiIgZmlsbD0iIzRBNEE0QSIvPgo8cGF0aCBkPSJNMjAgMjJDMjEuMTA0NyAyMiAyMiAyMS4xMDQ3IDIyIDIwQzIyIDE4Ljg5NTMgMjEuMTA0NyAxOCAyMCAxOEMxOC44OTUzIDE4IDE4IDE4Ljg5NTMgMTggMjBDMTggMjEuMTA0NyAxOC44OTUzIDIyIDIwIDIyWiIgZmlsbD0iIzRBNEE0QSIvPgo8cGF0aCBkPSJNMjAgMzBDMjEuMTA0NyAzMCAyMiAyOS4xMDQ3IDIyIDI4QzIyIDI2Ljg5NTMgMjEuMTA0NyAyNiAyMCAyNkMxOC44OTUzIDI2IDE4IDI2Ljg5NTMgMTggMjhDMTggMjkuMTA0NyAxOC44OTUzIDMwIDIwIDMwWiIgZmlsbD0iIzRBNEE0QSIvPgo8L3N2Zz4K';
    img.style.opacity = '0.5';
};

// Update the mode toggle initialization
document.addEventListener("DOMContentLoaded", function () {
    const toggle = document.getElementById("mode-toggle");
    
    // Only proceed if toggle exists
    if (toggle) {
        // Check stored preference (if any)
        if (localStorage.getItem("mode") === "light") {
            toggle.checked = true;
        } else {
            toggle.checked = false;
        }
        updateMode();

        // Update the mode by toggling body classes
        function updateMode() {
            if (toggle.checked) {
                document.body.classList.add("light-mode");
                document.body.classList.remove("dark-mode");
            } else {
                document.body.classList.add("dark-mode");
                document.body.classList.remove("light-mode");
            }
        }

        // Listen for changes on the toggle switch
        toggle.addEventListener("change", function () {
            updateMode();
            localStorage.setItem("mode", toggle.checked ? "light" : "dark");
        });
    }
});
