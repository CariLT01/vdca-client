// webpack.config.js
const path = require("path");
const TerserPlugin = require("terser-webpack-plugin");

module.exports = {
    entry: {
        main: './src/main.ts',         // Content script / page script
        background: './src/background.ts',  // Background/service worker
        overwrite: "./src/overwrite.ts"
    },
    output: {
        filename: '[name].js',         // Generates main.js and background.js
        path: path.resolve(__dirname, 'extension')
    },
    mode: 'production',
    resolve: {
        extensions: ['.ts', '.js']
    },
    module: {
        rules: [
            {
                test: /\.ts$/,
                exclude: /node_modules/,
                use: 'ts-loader'
            }
        ]
    }
};