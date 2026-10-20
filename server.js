const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const db = new sqlite3.Database('./competition.db', (err) => {
  if (err) console.error('Database connection error:', err);
  else console.log('Connected to SQLite database.');
});

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      unique_id TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      age INTEGER NOT NULL,
      sex TEXT NOT NULL,
      boulders_climbed TEXT NOT NULL,
      total_score REAL NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
});

// Helper function to derive category from age
function getCategoryFromAge(age) {
  if (age < 18) return 'Youth (<18)';
  if (age >= 40) return 'Masters (40+)';
  return 'Open (18-39)';
}

/**
 * Recalculate scores for ALL climbers isolated by (Category + Sex) group.
 * Points = 1000 / (number of ticks within the SAME category and sex).
 */
function recalculateAllScores(callback) {
  db.all(`SELECT id, age, sex, boulders_climbed FROM submissions`, [], (err, rows) => {
    if (err) return callback(err);
    if (rows.length === 0) return callback(null);

    // 1. Group tick counts by "Category_Sex" key and boulder ID
    // Format: { "Open (18-39)_Male": { 1: 5, 2: 3, ... }, ... }
    const groupTickCounts = {};

    rows.forEach(row => {
      const category = getCategoryFromAge(row.age);
      const groupKey = `${category}_${row.sex}`;

      if (!groupTickCounts[groupKey]) {
        groupTickCounts[groupKey] = {};
      }

      const climbs = JSON.parse(row.boulders_climbed);
      climbs.forEach(boulderId => {
        groupTickCounts[groupKey][boulderId] = (groupTickCounts[groupKey][boulderId] || 0) + 1;
      });
    });

    // 2. Update each participant's score based on their specific group's tick counts
    db.serialize(() => {
      const stmt = db.prepare(`UPDATE submissions SET total_score = ? WHERE id = ?`);

      rows.forEach(row => {
        const category = getCategoryFromAge(row.age);
        const groupKey = `${category}_${row.sex}`;
        const climbs = JSON.parse(row.boulders_climbed);
        let userScore = 0;

        climbs.forEach(boulderId => {
          const ticksInGroup = groupTickCounts[groupKey]?.[boulderId] || 1;
          userScore += 1000 / ticksInGroup;
        });

        // Round score to 2 decimal places
        stmt.run(Math.round(userScore * 100) / 100, row.id);
      });

      stmt.finalize((err) => {
        callback(err);
      });
    });
  });
}

// Submit or Update Scorecard
app.post('/api/submit', (req, res) => {
  const { name, age, sex, bouldersClimbed, uniqueId } = req.body;

  if (!name || !age || !sex || !Array.isArray(bouldersClimbed)) {
    return res.status(400).json({ error: 'Missing required fields or invalid data.' });
  }

  const climberId = uniqueId && uniqueId.trim() !== '' 
    ? uniqueId.trim() 
    : `BIB-${crypto.randomInt(1000, 9999)}`;

  const numericBoulders = bouldersClimbed.map(Number);
  const bouldersJson = JSON.stringify(numericBoulders);

  const query = `
    INSERT INTO submissions (unique_id, name, age, sex, boulders_climbed, total_score)
    VALUES (?, ?, ?, ?, ?, 0)
    ON CONFLICT(unique_id) DO UPDATE SET
      name = excluded.name,
      age = excluded.age,
      sex = excluded.sex,
      boulders_climbed = excluded.boulders_climbed
  `;

  db.run(query, [climberId, name.trim(), parseInt(age), sex, bouldersJson], function (err) {
    if (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to record submission.' });
    }

    recalculateAllScores((recalcErr) => {
      if (recalcErr) {
        console.error('Error recalculating scores:', recalcErr);
        return res.status(500).json({ error: 'Failed to calculate competition scores.' });
      }

      db.get(`SELECT total_score FROM submissions WHERE unique_id = ?`, [climberId], (err, row) => {
        res.json({
          success: true,
          uniqueId: climberId,
          totalScore: row ? row.total_score : 0
        });
      });
    });
  });
});

// Leaderboard API
app.get('/api/leaderboard', (req, res) => {
  db.all(
    `SELECT unique_id, name, age, sex, total_score, boulders_climbed FROM submissions ORDER BY total_score DESC`,
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });

      const formattedData = rows.map(row => ({
        uniqueId: row.unique_id,
        name: row.name,
        age: row.age,
        sex: row.sex,
        totalScore: row.total_score,
        totalTops: JSON.parse(row.boulders_climbed).length,
        category: getCategoryFromAge(row.age)
      }));

      res.json(formattedData);
    }
  );
});

// Boulder Ticks Stats API (Supports Optional Group Filtering)
app.get('/api/boulders', (req, res) => {
  const { sex, category } = req.query;

  db.all(`SELECT age, sex, boulders_climbed FROM submissions`, [], (err, rows) => {
    if (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to fetch boulder data.' });
    }

    // Filter rows if sex/category filters are passed
    const filteredRows = rows.filter(row => {
      const matchesSex = !sex || sex === 'ALL' || row.sex === sex;
      const matchesCategory = !category || category === 'ALL' || getCategoryFromAge(row.age) === category;
      return matchesSex && matchesCategory;
    });

    const totalClimbers = filteredRows.length;

    // Initialize stats array for 35 boulders
    const boulderStats = Array.from({ length: 35 }, (_, index) => ({
      boulderNumber: index + 1,
      tickCount: 0,
      currentPoints: 0
    }));

    filteredRows.forEach(row => {
      const climbs = JSON.parse(row.boulders_climbed);
      climbs.forEach(boulderNum => {
        if (boulderNum >= 1 && boulderNum <= 35) {
          boulderStats[boulderNum - 1].tickCount += 1;
        }
      });
    });

    boulderStats.forEach(boulder => {
      if (boulder.tickCount > 0) {
        boulder.currentPoints = Math.round((1000 / boulder.tickCount) * 100) / 100;
      } else {
        boulder.currentPoints = 1000;
      }
    });

    res.json({
      totalClimbers,
      boulders: boulderStats
    });
  });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});