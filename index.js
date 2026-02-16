const express = require('express');
const app = express();
const PORT = process.env.PORT || 10000;

app.get('/', (req, res) => {
    res.json({ 
        status: 'ok', 
        message: 'Server is running',
        timestamp: Date.now()
    });
});

app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'ok',
        uptime: process.uptime()
    });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Server running on port ${PORT}`);
});
