#!/bin/bash

# Deployment script for Stackcast contracts
# Usage: ./scripts/deploy.sh [testnet|mainnet]

set -e

NETWORK=${1:-testnet}

echo "🚀 Deploying Stackcast contracts to $NETWORK..."
echo ""

# Check if clarinet is installed
if ! command -v clarinet &> /dev/null; then
    echo "❌ Clarinet is not installed. Install it first:"
    echo "   brew install clarinet"
    exit 1
fi

# Check contracts
echo "1️⃣  Checking contracts..."
clarinet check
echo "✅ All contracts valid"
echo ""

# Run tests
echo "2️⃣  Running tests..."
clarinet test
echo "✅ Tests passed"
echo ""

# Deploy
echo "3️⃣  Deploying to $NETWORK..."
if [ "$NETWORK" == "mainnet" ]; then
    read -p "⚠️  Are you sure you want to deploy to MAINNET? (yes/no): " confirm
    if [ "$confirm" != "yes" ]; then
        echo "Deployment cancelled"
        exit 0
    fi
    clarinet deploy --mainnet
else
    clarinet deploy --testnet
fi

echo ""
echo "✅ Deployment complete!"
echo ""
echo "📝 Next steps:"
echo "   1. Copy the deployed contract addresses"
echo "   2. Update backend/.env with the addresses"
echo "   3. Start the backend: cd backend && bun start"
