// webpack.config.js
const path = require('path');

module.exports = {
  entry: './src/main.ts',          // Entry point
  output: {
    filename: 'bundle.js',          // Output file
    path: path.resolve(__dirname, 'extension')
  },
  mode: 'production',              // 'production' for production builds
  resolve: {
    extensions: ['.ts', '.js']     // Resolve these file types
  },
  module: {
    rules: [
      {
        test: /\.ts$/,              // Apply this rule to .ts files
        exclude: /node_modules/,
        use: 'ts-loader'            // Use ts-loader to handle TypeScript
      }
    ]
  },
};