const { Server } = require("socket.io")
const { createServer } = require("http")
const express = require('express')

const app = express()
const httpServer = createServer(app)
const io = new Server(httpServer, {
  cors: {
    origin: [
      "https://brush-rush.vercel.app",
      "http://localhost:3000",
    ],
    methods: ["GET", "POST"],
    credentials: true,
  },
  transports: ["websocket", "polling"],
  pingTimeout: 60000,
  pingInterval: 25000,
});


// Game state management
const rooms = new Map()
const playerRooms = new Map()
const roomTimers = new Map()

// Room interface structure (matching the TypeScript types)
const createRoom = (id, name, maxPlayers, isPrivate, password, customWords, rounds, drawTime, categories = [], difficulty = "mixed") => ({
  id,
  name,
  maxPlayers,
  isPrivate,
  password,
  customWords,
  rounds,
  drawTime,
  categories,
  difficulty,
  players: [],
  currentRound: 0,
  currentDrawer: null,
  currentWord: null,
  gameState: "waiting", // 'waiting', 'playing', 'finished'
  gamePhase: "waiting",
  currentWordCategory: "",
  currentWordIsCustom: false,
  timeLeft: 0,
  scores: {},
  usedWords: [],
  drawingData: [],
})

const createPlayer = (id, name, avatar) => ({
  id,
  name,
  avatar,
  score: 0,
  isHost: false,
  isDrawing: false,
  socketId: id,
  hasGuessed: false,
})

// Utility functions
const generateRoomId = () => Math.random().toString(36).substring(2, 8).toUpperCase()

const getRandomWord = (customWords, categories = [], difficulty = "mixed") => {
  // Default words by category
  const wordsByCategory = {
    Animals: ["cat", "dog", "elephant", "tiger", "lion", "bird", "fish", "horse", "rabbit", "bear"],
    Objects: ["chair", "table", "car", "house", "phone", "book", "computer", "pen", "clock", "lamp"],
    Food: ["pizza", "burger", "apple", "banana", "cake", "bread", "ice cream", "pasta", "chicken", "salad"],
    Nature: ["tree", "flower", "mountain", "river", "sun", "moon", "star", "cloud", "rain", "snow"],
    Actions: ["running", "jumping", "swimming", "dancing", "singing", "reading", "writing", "cooking", "sleeping", "laughing"],
    Abstract: ["love", "happiness", "freedom", "peace", "hope", "dream", "fear", "anger", "joy", "wisdom"]
  }

  // Difficulty levels
  const difficultyWords = {
    easy: ["cat", "dog", "sun", "car", "house", "tree", "book", "ball", "fish", "bird"],
    medium: ["elephant", "computer", "mountain", "happiness", "dancing", "cooking", "flower", "river", "clock", "phone"],
    hard: ["philosophy", "democracy", "ecosystem", "architecture", "psychology", "phenomenon", "inevitable", "consciousness", "metaphor", "transcendence"]
  }

  let wordList = []

  // Use custom words if available
  if (customWords && customWords.length > 0) {
    wordList = [...customWords]
  }

  // Add words from selected categories
  if (categories && categories.length > 0) {
    categories.forEach(category => {
      if (wordsByCategory[category]) {
        wordList = [...wordList, ...wordsByCategory[category]]
      }
    })
  }

  // Add difficulty-based words
  if (difficulty === "mixed") {
    Object.values(difficultyWords).forEach(words => {
      wordList = [...wordList, ...words]
    })
  } else if (difficultyWords[difficulty]) {
    wordList = [...wordList, ...difficultyWords[difficulty]]
  }

  // Fallback to default words if no words available
  if (wordList.length === 0) {
    wordList = ["cat", "dog", "house", "tree", "car", "sun", "moon", "star", "fish", "bird"]
  }

  // Remove duplicates
  wordList = [...new Set(wordList)]

  return wordList[Math.floor(Math.random() * wordList.length)]
}

const startRoundTimer = (roomId) => {
  const room = rooms.get(roomId)
  if (!room) return

  if (roomTimers.has(roomId)) {
    clearInterval(roomTimers.get(roomId))
  }

  room.timeLeft = room.drawTime
  room.gamePhase = "drawing"

  const timer = setInterval(() => {
    room.timeLeft--
    io.to(roomId).emit("timer-update", { timeLeft: room.timeLeft })

    if (room.timeLeft <= 0) {
      clearInterval(timer)
      roomTimers.delete(roomId)
      endRound(roomId)
    }
  }, 1000)

  roomTimers.set(roomId, timer)
}

const endRound = (roomId) => {
  const room = rooms.get(roomId)
  if (!room) return

  // Emit round ended event with the word
  io.to(roomId).emit("round-ended", { 
    room, 
    word: room.currentWord 
  })

  // Reset drawing status for all players
  room.players.forEach((player) => {
    player.isDrawing = false
    player.hasGuessed = false // Reset for next round
  })

  room.currentRound++

  if (room.currentRound > room.rounds) {
    // Game finished
    room.gameState = "finished"
    room.gamePhase = "waiting"
    io.to(roomId).emit("game-finished", { room })
  } else {
    // Start next round after a short delay
    setTimeout(() => {
      startNextRound(roomId)
    }, 2000) // 2 second delay between rounds
  }
}

const startNextRound = (roomId) => {
  const room = rooms.get(roomId)
  if (!room) return

  // Reset player guess status and drawing status
  room.players.forEach((player) => {
    player.hasGuessed = false
    player.isDrawing = false
  })

  // Select next drawer
  const currentDrawerIndex = room.players.findIndex((p) => p.id === room.currentDrawer?.id)
  const nextDrawerIndex = (currentDrawerIndex + 1) % room.players.length
  room.currentDrawer = room.players[nextDrawerIndex]
  room.currentDrawer.isDrawing = true

  // Select new word
  room.currentWord = getRandomWord(room.customWords, room.categories, room.difficulty)
  room.usedWords.push(room.currentWord)
  room.currentWordCategory = room.customWords && room.customWords.includes(room.currentWord) ? "Custom" : "Default"
  room.currentWordIsCustom = room.customWords && room.customWords.includes(room.currentWord)

  // Clear drawing data for new round
  room.drawingData = []

  // Notify all players about round start (this will clear their canvases)
  io.to(roomId).emit("round-started", {
    room,
    word: room.currentWord,
    drawer: room.currentDrawer,
  })

  startRoundTimer(roomId)
}

const resetGame = (roomId) => {
  const room = rooms.get(roomId)
  if (!room) return

  // Clear any existing timers
  if (roomTimers.has(roomId)) {
    clearInterval(roomTimers.get(roomId))
    roomTimers.delete(roomId)
  }

  // Reset game state
  room.gameState = "waiting"
  room.gamePhase = "waiting"
  room.currentRound = 0
  room.currentDrawer = null
  room.currentWord = null
  room.currentWordCategory = ""
  room.currentWordIsCustom = false
  room.timeLeft = 0
  room.usedWords = []
  room.drawingData = []

  // Reset player states
  room.players.forEach((player) => {
    player.score = 0
    player.isDrawing = false
    player.hasGuessed = false
    room.scores[player.id] = 0
  })

  return room
}

io.on("connection", (socket) => {
  console.log("Player connected:", socket.id)

  socket.on("create-room", ({ roomData, player }) => {
    try {
      // Generate a unique room ID
      let roomId = generateRoomId()
      while (rooms.has(roomId)) {
        roomId = generateRoomId()
      }

      console.log(`[Server] Creating room ${roomId} with data:`, roomData)

      const room = createRoom(
        roomId,
        roomData.name,
        roomData.maxPlayers,
        roomData.isPrivate,
        roomData.password,
        roomData.customWords,
        roomData.rounds,
        roomData.drawTime,
        roomData.categories || ["Animals", "Objects", "Food", "Nature"],
        roomData.difficulty || "mixed"
      )

      const newPlayer = createPlayer(socket.id, player.name, player.avatar)
      newPlayer.isHost = true
      room.players.push(newPlayer)
      room.scores[socket.id] = 0

      rooms.set(roomId, room)
      playerRooms.set(socket.id, roomId)
      socket.join(roomId)

      console.log(`[Server] Room ${roomId} created by ${player.name}`)
      socket.emit("room-created", { roomId, room })
    } catch (error) {
      console.error("Create room error:", error)
      socket.emit("error", { message: "Failed to create room: " + error.message })
    }
  })

  socket.on("update-room", (roomData) => {
    try {
      console.log(`[Server] Update room request for ${roomData.roomId}:`, roomData)
      const room = rooms.get(roomData.roomId)

      if (!room) {
        socket.emit("error", { message: "Room not found" })
        return
      }

      const player = room.players.find((p) => p.id === socket.id)
      if (!player?.isHost) {
        socket.emit("error", { message: "Only the host can update room settings" })
        return
      }

      // Update room settings
      if (roomData.isPrivate !== undefined) room.isPrivate = roomData.isPrivate
      if (roomData.password !== undefined) room.password = roomData.password
      if (roomData.maxPlayers !== undefined) room.maxPlayers = roomData.maxPlayers
      if (roomData.rounds !== undefined) room.rounds = roomData.rounds
      if (roomData.drawTime !== undefined) room.drawTime = roomData.drawTime
      if (roomData.customWords !== undefined) room.customWords = roomData.customWords
      if (roomData.categories !== undefined) room.categories = roomData.categories
      if (roomData.difficulty !== undefined) room.difficulty = roomData.difficulty

      console.log(`[Server] Room ${roomData.roomId} settings updated`)
      io.to(roomData.roomId).emit("room-updated", { room })
    } catch (error) {
      console.error("Update room error:", error)
      socket.emit("error", { message: "Failed to update room: " + error.message })
    }
  })

  socket.on("restart-game", ({ roomId, roomData }) => {
    try {
      console.log(`[Server] Restart game request for ${roomId}:`, roomData)
      const room = rooms.get(roomId)

      if (!room) {
        socket.emit("error", { message: "Room not found" })
        return
      }

      const player = room.players.find((p) => p.id === socket.id)
      if (!player?.isHost) {
        socket.emit("error", { message: "Only the host can restart the game" })
        return
      }

      // Update room settings if provided
      if (roomData) {
        if (roomData.isPrivate !== undefined) room.isPrivate = roomData.isPrivate
        if (roomData.password !== undefined) room.password = roomData.password
        if (roomData.maxPlayers !== undefined) room.maxPlayers = roomData.maxPlayers
        if (roomData.rounds !== undefined) room.rounds = roomData.rounds
        if (roomData.drawTime !== undefined) room.drawTime = roomData.drawTime
        if (roomData.customWords !== undefined) room.customWords = roomData.customWords
        if (roomData.categories !== undefined) room.categories = roomData.categories
        if (roomData.difficulty !== undefined) room.difficulty = roomData.difficulty
      }

      // Reset the game
      resetGame(roomId)

      console.log(`[Server] Game restarted in room ${roomId}`)
      io.to(roomId).emit("game-restarted", { room })
    } catch (error) {
      console.error("Restart game error:", error)
      socket.emit("error", { message: "Failed to restart game: " + error.message })
    }
  })

  socket.on("join-room", ({ roomId, player, password }) => {
    try {
      console.log(`[Server] Join room request: ${roomId} by ${player.name}`)
      const room = rooms.get(roomId)

      if (!room) {
        console.log(`[Server] Room ${roomId} not found`)
        socket.emit("error", { message: "Room not found" })
        return
      }

      if (room.players.length >= room.maxPlayers) {
        socket.emit("error", { message: "Room is full" })
        return
      }

      if (room.isPrivate && room.password && room.password !== password) {
        socket.emit("error", { message: "Incorrect password" })
        return
      }

      // Check if player is already in the room
      const existingPlayer = room.players.find(p => p.id === socket.id)
      if (existingPlayer) {
        console.log(`[Server] Player ${player.name} already in room ${roomId}`)
        socket.emit("room-joined", { room })
        return
      }

      // Check if player is already in another room
      const currentRoomId = playerRooms.get(socket.id)
      if (currentRoomId && currentRoomId !== roomId) {
        const currentRoom = rooms.get(currentRoomId)
        if (currentRoom) {
          // Remove player from current room
          currentRoom.players = currentRoom.players.filter(p => p.id !== socket.id)
          delete currentRoom.scores[socket.id]
          socket.leave(currentRoomId)
          socket.to(currentRoomId).emit("player-left", {
            player: { id: socket.id, name: player.name },
            players: currentRoom.players
          })
        }
      }

      const newPlayer = createPlayer(socket.id, player.name, player.avatar)
      room.players.push(newPlayer)
      room.scores[socket.id] = 0

      playerRooms.set(socket.id, roomId)
      socket.join(roomId)

      console.log(`[Server] ${player.name} joined room ${roomId}`)
      socket.emit("room-joined", { room })
      socket.to(roomId).emit("player-joined", { player: newPlayer, players: room.players })

      // Send existing drawing data to new player if game is in progress
      if (room.gameState === "playing" && room.drawingData.length > 0) {
        room.drawingData.forEach(event => {
          socket.emit("drawing-event", event)
        })
      }
    } catch (error) {
      console.error("Join room error:", error)
      socket.emit("error", { message: "Failed to join room: " + error.message })
    }
  })

  socket.on("start-game", ({ roomId }) => {
    try {
      const room = rooms.get(roomId)
      if (!room) {
        socket.emit("error", { message: "Room not found" })
        return
      }

      const player = room.players.find((p) => p.id === socket.id)
      if (!player?.isHost) {
        socket.emit("error", { message: "Only the host can start the game" })
        return
      }

      if (room.players.length < 2) {
        socket.emit("error", { message: "Need at least 2 players to start" })
        return
      }

      if (room.gameState === "playing") {
        socket.emit("error", { message: "Game is already in progress" })
        return
      }

      room.gameState = "playing"
      room.gamePhase = "drawing"
      room.currentRound = 1
      
      // Set first drawer
      room.currentDrawer = room.players[0]
      room.currentDrawer.isDrawing = true
      
      room.currentWord = getRandomWord(room.customWords, room.categories, room.difficulty)
      room.usedWords.push(room.currentWord)
      room.currentWordCategory = room.customWords && room.customWords.includes(room.currentWord) ? "Custom" : "Default"
      room.currentWordIsCustom = room.customWords && room.customWords.includes(room.currentWord)

      // Clear drawing data for new game
      room.drawingData = []

      console.log(`[Server] Game started in room ${roomId}`)
      io.to(roomId).emit("game-started", { room })
      io.to(roomId).emit("round-started", {
        room,
        word: room.currentWord,
        drawer: room.currentDrawer,
      })

      startRoundTimer(roomId)
    } catch (error) {
      console.error("Start game error:", error)
      socket.emit("error", { message: "Failed to start game: " + error.message })
    }
  })

  socket.on("chat-message", ({ roomId, message }) => {
    try {
      const room = rooms.get(roomId)
      if (!room) return

      const player = room.players.find((p) => p.id === socket.id)
      if (!player) return

      const chatMessage = {
        id: Date.now(),
        player: player.name,
        message,
        type: "chat",
        timestamp: Date.now(),
      }

      // Check if it's a correct guess
      if (
        room.gameState === "playing" &&
        room.currentWord &&
        message.toLowerCase().trim() === room.currentWord.toLowerCase() &&
        socket.id !== room.currentDrawer?.id &&
        !player.hasGuessed
      ) {
        player.hasGuessed = true
        const points = Math.max(10, Math.floor(room.timeLeft / 2))
        room.scores[socket.id] += points
        player.score += points

        io.to(roomId).emit("correct-guess", {
          player: player.name,
          word: room.currentWord,
          points,
        })

        // Check if all players have guessed
        const nonDrawerPlayers = room.players.filter((p) => p.id !== room.currentDrawer?.id)
        const allGuessed = nonDrawerPlayers.every((p) => p.hasGuessed)

        if (allGuessed) {
          // All players guessed correctly, end round immediately
          if (roomTimers.has(roomId)) {
            clearInterval(roomTimers.get(roomId))
            roomTimers.delete(roomId)
          }
          endRound(roomId)
        }
      } else {
        // Regular chat message
        io.to(roomId).emit("chat-message", chatMessage)
      }
    } catch (error) {
      console.error("Chat message error:", error)
    }
  })

  socket.on("drawing-event", ({ roomId, event }) => {
    try {
      const room = rooms.get(roomId)
      if (!room) return

      const player = room.players.find((p) => p.id === socket.id)
      if (!player?.isDrawing) return

      // Store the drawing event
      room.drawingData.push(event)
      
      // Broadcast to all other players in the room
      socket.to(roomId).emit("drawing-event", event)
      
      console.log(`[Server] Drawing event ${event.type} broadcasted to room ${roomId}`)
    } catch (error) {
      console.error("Drawing event error:", error)
    }
  })

  socket.on("clear-canvas", ({ roomId }) => {
    try {
      const room = rooms.get(roomId)
      if (!room) return

      const player = room.players.find((p) => p.id === socket.id)
      if (!player?.isDrawing) return

      // Clear stored drawing data
      room.drawingData = []
      
      // Broadcast canvas clear to all other players
      socket.to(roomId).emit("canvas-cleared")
      
      console.log(`[Server] Canvas cleared and broadcasted to room ${roomId}`)
    } catch (error) {
      console.error("Clear canvas error:", error)
    }
  })

  socket.on("kick-player", ({ roomId, playerId }) => {
    try {
      const room = rooms.get(roomId)
      if (!room) return

      const host = room.players.find((p) => p.id === socket.id)
      if (!host?.isHost) return

      const playerToKick = room.players.find((p) => p.id === playerId)
      if (!playerToKick) return

      room.players = room.players.filter((p) => p.id !== playerId)
      delete room.scores[playerId]
      playerRooms.delete(playerId)

      io.to(playerId).emit("kicked")
      socket.to(roomId).emit("player-left", {
        player: playerToKick,
        players: room.players,
      })

      console.log(`[Server] ${playerToKick.name} was kicked from room ${roomId}`)
    } catch (error) {
      console.error("Kick player error:", error)
    }
  })

  socket.on("get-public-rooms", () => {
    try {
      const publicRooms = []
      for (const [roomId, room] of rooms.entries()) {
        if (!room.isPrivate) {
          publicRooms.push({
            id: roomId,
            name: room.name,
            playerCount: room.players.length,
            maxPlayers: room.maxPlayers,
            gamePhase: room.gamePhase,
            round: room.currentRound,
            maxRounds: room.rounds,
            difficulty: room.difficulty,
            categories: room.categories,
            host: room.players[0]?.name || "Unknown",
            isPrivate: room.isPrivate,
            hasPassword: !!room.password,
          })
        }
      }
      console.log(`[Server] Sending ${publicRooms.length} public rooms`)
      socket.emit("public-rooms", { rooms: publicRooms })
    } catch (error) {
      console.error("Get public rooms error:", error)
    }
  })

  socket.on("disconnect", () => {
    try {
      const roomId = playerRooms.get(socket.id)
      if (!roomId) return

      const room = rooms.get(roomId)
      if (!room) return

      const player = room.players.find((p) => p.id === socket.id)
      if (!player) return

      room.players = room.players.filter((p) => p.id !== socket.id)
      delete room.scores[socket.id]
      playerRooms.delete(socket.id)

      if (room.players.length === 0) {
        // Clean up empty room
        if (roomTimers.has(roomId)) {
          clearInterval(roomTimers.get(roomId))
          roomTimers.delete(roomId)
        }
        rooms.delete(roomId)
        console.log(`[Server] Room ${roomId} deleted (empty)`)
      } else {
        // Transfer host if needed
        if (player.isHost && room.players.length > 0) {
          room.players[0].isHost = true
          console.log(`[Server] Host transferred to ${room.players[0].name} in room ${roomId}`)
        }

        // If the disconnected player was drawing, end the round
        if (player.isDrawing) {
          if (roomTimers.has(roomId)) {
            clearInterval(roomTimers.get(roomId))
            roomTimers.delete(roomId)
          }
          endRound(roomId)
        }

        socket.to(roomId).emit("player-left", {
          player,
          players: room.players,
        })
      }

      console.log(`[Server] Player ${player.name} disconnected from room ${roomId}`)
    } catch (error) {
      console.error("Disconnect error:", error)
    }
  })

  // Send periodic stats updates
  setInterval(() => {
    const stats = {
      totalRooms: rooms.size,
      totalPlayers: Array.from(rooms.values()).reduce((sum, room) => sum + room.players.length, 0),
      activeGames: Array.from(rooms.values()).filter(room => room.gameState === "playing").length,
    }
    io.emit("server-stats", stats)
  }, 30000) // Every 30 seconds
})

app.get("/", (req, res) => {
  res.send("Brush Rush Server")
})

const PORT = process.env.SOCKET_PORT || 3001
httpServer.listen(PORT,"0.0.0.0", () => {
  console.log(`Socket.IO server running on port ${PORT}`)
  console.log(`WebSocket URL: ws://localhost:${PORT}`)
  console.log("Ready to accept connections...")
  console.log("Supported events:")
  console.log("- create-room, join-room, start-game")
  console.log("- update-room, restart-game")
  console.log("- chat-message, drawing-event, clear-canvas")
  console.log("- kick-player, get-public-rooms")
})