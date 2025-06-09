module.exports = {
  apps: [
    {
      name: "discord-bot",
      script: "./index.js",
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
