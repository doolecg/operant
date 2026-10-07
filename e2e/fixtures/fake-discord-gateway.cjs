// A stand-in for the Discord gateway: no network. A token starting "bad-token" is refused; any other token connects as
// FrontDeskBot in one server, and a moment after connecting an unknown user (id 555) direct-messages the bot.
exports.createGateway = () => {
  let onMessage = null
  let timer = null
  return {
    async connect(token) {
      if (token.startsWith('bad-token')) throw new Error('An invalid token was provided')
      timer = setTimeout(() => {
        onMessage?.({
          id: 'm1',
          channelId: 'dm-555',
          parentId: null,
          authorId: '555',
          authorName: 'newcomer',
          authorIsBot: false,
          content: 'hello',
          isDirect: true,
          mentionsBot: false,
        })
      }, 400)
      return { userId: '900', username: 'FrontDeskBot' }
    },
    async disconnect() {
      clearTimeout(timer)
    },
    guilds: () => [{ id: '1', name: 'Test Server' }],
    onMessage: (cb) => (onMessage = cb),
    onReaction() {},
    onClosed() {},
    onRestored() {},
    send: async () => 'sent-1',
    react: async () => {},
    createThread: async () => 'thread-1',
    renameThread: async () => {},
  }
}
