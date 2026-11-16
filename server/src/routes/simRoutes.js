import crypto from 'crypto';
import express from 'express';
import mongoose from 'mongoose';
import { OperatorAction } from '../models/OperatorAction.js';
import { Device } from '../models/Device.js';
import { simulatorService } from '../services/simulatorService.js';
import { rolloutPredictedEffect } from '../services/copilotService.js';
import {
  authenticate,
  publicReadOrAuth,
  requireRole,
  requireJunctionZoneAccess,
} from '../middleware/auth.js';

const router = express.Router();

// Live simulation state, per-junction active controller specs, and study supervisory policy
router.get('/state', publicReadOrAuth, (req, res) => {
  try {
    simulatorService.stepServerlessIfDue();
    res.json({
      success: true,
      ...simulatorService.getState(),
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Combined single-round-trip snapshot for HTTP polling mode (serverless fallback)
router.get('/live-snapshot', publicReadOrAuth, (req, res) => {
  try {
    simulatorService.stepServerlessIfDue();
    res.json({
      success: true,
      serverTimestamp: Date.now(),
      state: simulatorService.getState(),
      counterfactual: simulatorService.getCounterfactual(),
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Paired CRN counterfactual comparison between Live Twin and Fixed-TOD Baseline Twin
router.get('/counterfactual', publicReadOrAuth, (req, res) => {
  try {
    simulatorService.stepServerlessIfDue();
    res.json({
      success: true,
      ...simulatorService.getCounterfactual(),
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// List available realistic Bengaluru traffic scenario presets
router.get('/scenarios', publicReadOrAuth, (req, res) => {
  res.json({
    success: true,
    scenarios: simulatorService.getScenarios(),
    active: simulatorService.activeScenario,
    ...simulatorService.getScenarioMeta(),
  });
});

// Switch scenario preset cleanly across both CRN twins (operator+ required)
router.post(
  '/scenario',
  authenticate,
  requireRole(['admin', 'operator']),
  (req, res) => {
    try {
      const { scenarioId } = req.body || {};
      if (!scenarioId) {
        return res.status(400).json({ success: false, error: 'scenarioId is required' });
      }
      const actor = req.user.name || req.user.email || 'Operator';
      const result = simulatorService.applyScenario(scenarioId, { actor });
      res.json({
        success: true,
        ...result,
      });
    } catch (err) {
      const code = err.message?.includes('Unknown scenario') ? 400 : 500;
      res.status(code).json({ success: false, error: err.message });
    }
  }
);

// Adjust simulation clock multiplier (admin only: 1x, 2x, 5x)
router.post(
  '/speed',
  authenticate,
  requireRole(['admin']),
  (req, res) => {
    const parsed = Number(req.body?.speed);
    if (![1, 2, 5].includes(parsed)) {
      return res.status(400).json({
        success: false,
        error: 'speed must be one of 1, 2, or 5',
      });
    }
    const simSpeed = simulatorService.setSimSpeed(parsed);
    res.json({
      success: true,
      simSpeed,
      ...simulatorService.getScenarioMeta(),
    });
  }
);

// Switch active controller on one junction or 'all' (admin for city-wide, zone-scoped operator for single junction)
router.post(
  '/controller',
  authenticate,
  requireRole(['admin', 'operator']),
  requireJunctionZoneAccess,
  async (req, res) => {
    try {
      const { junctionId, controller } = req.body || {};
      if (!junctionId || !controller) {
        return res.status(400).json({
          success: false,
          error: 'junctionId (or "all") and controller are required',
        });
      }

      const actor = req.user.name || req.user.email || 'Operator';
      const actorRole = req.user.role || 'operator';
      const liveWorld = simulatorService.pair.live;
      const isAll = junctionId === 'all' || junctionId === '*';

      let predictedEffect = null;
      let baselineMetricsAtAction = {};
      if (!isAll && liveWorld.junctionIndexById.has(junctionId)) {
        const startSnap = liveWorld.snapshot(junctionId);
        const cf = simulatorService.pair.comparison();
        predictedEffect = rolloutPredictedEffect(
          liveWorld,
          junctionId,
          (w) => w.setController(junctionId, controller),
          300
        );
        baselineMetricsAtAction = {
          junctionDelayVehSec: startSnap.kpi.delayVehSec,
          avgDelayPerVehSec: startSnap.kpi.avgDelayPerVehSec,
          maxQueueLengthM: startSnap.maxQueueLengthM,
          avgSpeedKmph: startSnap.avgSpeedKmph,
          congestionScore: startSnap.congestionScore,
          cfDelaySavedVehSecAtAction: cf.byJunction[junctionId]?.delaySavedVehSec ?? 0,
        };
      }

      const result = simulatorService.setController(junctionId, controller, actor);

      const actionId = `ACT-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
      const actionRecord = {
        actionId,
        junctionId: result.target,
        deviceId: result.target,
        actor,
        actorRole,
        actionType: 'switch_controller',
        findingId: null,
        params: {
          controller,
          previousControllers: result.previousControllers,
        },
        studyEvidence: null,
        simTimeAtAction: new Date(liveWorld.simTimeMs),
        elapsedSecAtAction: liveWorld.elapsedSec,
        targetMeasureElapsedSec: liveWorld.elapsedSec + 300,
        baselineMetricsAtAction,
        predictedEffect: predictedEffect || { scope: 'network-wide', controller },
        realisedEffect: null,
        status: isAll ? 'measured' : 'pending',
        resolvedAlertsCount: 0,
      };

      if (mongoose.connection?.readyState === 1) {
        await OperatorAction.create(actionRecord);
        const filter = isAll ? {} : { deviceId: junctionId };
        await Device.updateMany(filter, { $set: { adaptiveSignalMode: controller } });
      }

      if (!isAll) {
        simulatorService.registerPendingAction(actionRecord);
      } else {
        simulatorService.recentActions.unshift(actionRecord);
      }

      res.json({
        success: true,
        ...result,
        actionRecord,
      });
    } catch (err) {
      const statusCode =
        err.message?.includes('Unsupported') || err.message?.includes('Unknown') ? 400 : 500;
      res.status(statusCode).json({ success: false, error: err.message });
    }
  }
);

export default router;
