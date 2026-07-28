import { Router } from 'express';
import { ConfigStore } from '../server/configStore';
import { DEFAULT_CONFIG } from '../config/game-config';

const router = Router();
const configStore = new ConfigStore();

/**
 * Get current configuration values
 * Merges stored values with defaults
 */
router.get('/api/config', async (req, res) => {
  try {
    // Get stored config
    const storedConfig = await configStore.getAll();
    
    // Merge with defaults (stored values override defaults)
    const mergedConfig = {
      ...DEFAULT_CONFIG,
      ...storedConfig
    };
    
    res.json({
      config: mergedConfig,
      defaults: DEFAULT_CONFIG
    });
  } catch (error) {
    console.error('Error getting config:', error);
    res.status(500).json({ 
      error: 'Failed to get configuration',
      config: DEFAULT_CONFIG,
      defaults: DEFAULT_CONFIG
    });
  }
});

/**
 * Update configuration values
 */
router.post('/api/config', async (req, res) => {
  try {
    const updates = req.body;
    
    // Validate that we're only updating known config keys
    const validKeys = Object.keys(DEFAULT_CONFIG);
    const updateKeys = Object.keys(updates);
    const invalidKeys = updateKeys.filter(key => !validKeys.includes(key));
    
    if (invalidKeys.length > 0) {
      return res.status(400).json({ 
        error: `Invalid configuration keys: ${invalidKeys.join(', ')}` 
      });
    }
    
    // Validate value types
    for (const [key, value] of Object.entries(updates)) {
      const defaultValue = DEFAULT_CONFIG[key as keyof typeof DEFAULT_CONFIG];
      if (typeof defaultValue === 'number' && typeof value !== 'number') {
        return res.status(400).json({ 
          error: `Configuration key '${key}' must be a number` 
        });
      }
      if (typeof defaultValue === 'boolean' && typeof value !== 'boolean') {
        return res.status(400).json({ 
          error: `Configuration key '${key}' must be a boolean` 
        });
      }
    }
    
    // Range check: idle timeout must be a sane positive number of minutes
    // (matches the 1-120 range offered by the config UI).
    if ('idleTimeoutMinutes' in updates) {
      const v = updates.idleTimeoutMinutes;
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 1 || v > 120) {
        return res.status(400).json({
          error: `Configuration key 'idleTimeoutMinutes' must be between 1 and 120`
        });
      }
    }
    
    // Save to store
    await configStore.setMultiple(updates);
    
    // Return merged config
    const storedConfig = await configStore.getAll();
    const mergedConfig = {
      ...DEFAULT_CONFIG,
      ...storedConfig
    };
    
    res.json({ 
      success: true,
      config: mergedConfig 
    });
  } catch (error) {
    console.error('Error updating config:', error);
    res.status(500).json({ 
      error: 'Failed to update configuration' 
    });
  }
});

/**
 * Reset configuration to defaults
 */
router.delete('/api/config', async (req, res) => {
  try {
    await configStore.clear();
    res.json({ 
      success: true,
      config: DEFAULT_CONFIG 
    });
  } catch (error) {
    console.error('Error resetting config:', error);
    res.status(500).json({ 
      error: 'Failed to reset configuration' 
    });
  }
});

export default router;