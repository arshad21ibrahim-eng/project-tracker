require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");

const app = express();
app.use(express.json());
app.use(cors({ origin: process.env.FRONTEND_URL || "*" }));

/* -------------------- MongoDB Connection (with retry) -------------------- */
const connectDB = async (retries = 5) => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("MongoDB connected");
  } catch (err) {
    if (retries === 0) throw err;
    console.log("MongoDB retrying...");
    setTimeout(() => connectDB(retries - 1), 3000);
  }
};
connectDB();

/* -------------------- Schema & Model -------------------- */
const outageSchema = new mongoose.Schema({
  service: {
    type: String,
    required: true,
    enum: ["Electricity", "Water", "Internet", "Transport"]
  },
  area: { type: String, required: true },
  downTime: { type: Date, required: true },
  upTime: { type: Date, default: null },
  durationMinutes: { type: Number, default: null },
  status: { type: String, enum: ["ongoing", "resolved"], default: "ongoing" },
  confirmCount: { type: Number, default: 1 },
  confidenceLevel: {
    type: String,
    enum: ["unverified", "likely", "confirmed"],
    default: "unverified"
  },
  createdAt: { type: Date, default: Date.now }
});

const Outage = mongoose.model("Outage", outageSchema);

/* -------------------- Helper Functions -------------------- */
const getConfidenceLevel = (count) => {
  if (count >= 3) return "confirmed";
  if (count === 2) return "likely";
  return "unverified";
};

const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(id);

/* -------------------- ROUTES -------------------- */

/* 1️⃣ Report Service Downtime */
app.post("/api/outages", async (req, res, next) => {
  try {
    const { service, area, downTime } = req.body;
    if (!service || !area || !downTime) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    // Check for duplicate ongoing outage
    const existing = await Outage.findOne({
      service,
      area,
      status: "ongoing"
    });

    if (existing) {
      existing.confirmCount += 1;
      existing.confidenceLevel = getConfidenceLevel(existing.confirmCount);
      await existing.save();
      return res.status(200).json({
        message: "Confirmation added",
        outage: existing
      });
    }

    const outage = await Outage.create({
      service,
      area,
      downTime: new Date(downTime), // backend controls parsing
      confirmCount: 1,
      confidenceLevel: "unverified"
    });

    res.status(201).json(outage);
  } catch (err) {
    next(err);
  }
});

/* 2️⃣ Get All Outages */
app.get("/api/outages", async (req, res, next) => {
  try {
    const outages = await Outage.find().sort({ createdAt: -1 });
    res.json(outages);
  } catch (err) {
    next(err);
  }
});

/* 3️⃣ Restore Service */
app.put("/api/outages/:id/restore", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id))
      return res.status(400).json({ message: "Invalid ID" });

    const outage = await Outage.findById(id);
    if (!outage) return res.status(404).json({ message: "Not found" });
    if (outage.status === "resolved")
      return res.status(400).json({ message: "Already resolved" });

    outage.upTime = new Date();
    outage.durationMinutes =
      (outage.upTime - outage.downTime) / 60000;
    outage.status = "resolved";

    await outage.save();
    res.json(outage);
  } catch (err) {
    next(err);
  }
});

/* 4️⃣ Downtime Analytics */
app.get("/api/outages/stats", async (req, res, next) => {
  try {
    const outages = await Outage.find({ status: "resolved" });
    if (outages.length === 0) return res.json({});

    let totalMinutes = 0;
    const serviceTotals = {};

    outages.forEach(o => {
      totalMinutes += o.durationMinutes;
      serviceTotals[o.service] =
        (serviceTotals[o.service] || 0) + o.durationMinutes;
    });

    const avg = totalMinutes / outages.length;
    const reliability = {};

    for (const service in serviceTotals) {
      const hours = serviceTotals[service] / 60;
      reliability[service] = Math.max(0, 100 - hours * 2);
    }

    res.json({
      totalDowntimeMinutes: totalMinutes,
      averageDowntimeMinutes: avg,
      serviceWiseDowntime: serviceTotals,
      reliabilityScores: reliability
    });
  } catch (err) {
    next(err);
  }
});

/* 5️⃣ Time-Based Intelligence */
app.get("/api/outages/insights", async (req, res, next) => {
  try {
    const outages = await Outage.find();
    if (outages.length === 0) return res.json({});

    const hourMap = {};
    const dayMap = {};
    const areaMap = {};

    outages.forEach(o => {
      const hour = o.downTime.getHours();
      const day = o.downTime.getDay();
      hourMap[hour] = (hourMap[hour] || 0) + 1;
      dayMap[day] = (dayMap[day] || 0) + 1;
      areaMap[o.area] = (areaMap[o.area] || 0) + 1;
    });

    const maxKey = (obj) =>
      Object.keys(obj).reduce((a, b) => obj[a] > obj[b] ? a : b);

    res.json({
      peakOutageHour: maxKey(hourMap),
      worstDayOfWeek: maxKey(dayMap),
      recurringAreas: areaMap
    });
  } catch (err) {
    next(err);
  }
});

/* 6️⃣ Impact Metrics */
app.get("/api/outages/impact", async (req, res, next) => {
  try {
    const outages = await Outage.find({ status: "resolved" });
    if (outages.length === 0) return res.json({});

    let totalHours = 0;
    const areaImpact = {};
    const serviceImpact = {};

    outages.forEach(o => {
      const hours = o.durationMinutes / 60;
      totalHours += hours;
      areaImpact[o.area] = (areaImpact[o.area] || 0) + hours;
      serviceImpact[o.service] =
        (serviceImpact[o.service] || 0) + hours;
    });

    const maxKey = (obj) =>
      Object.keys(obj).reduce((a, b) => obj[a] > obj[b] ? a : b);

    res.json({
      estimatedTimeLostHours: totalHours,
      mostAffectedArea: maxKey(areaImpact),
      mostDisruptiveService: maxKey(serviceImpact)
    });
  } catch (err) {
    next(err);
  }
});

/* 🔐 Admin Delete */
app.delete("/api/outages/:id", async (req, res, next) => {
  try {
    if (req.headers["x-admin-password"] !== process.env.ADMIN_PASSWORD) {
      return res.status(403).json({ message: "Forbidden" });
    }

    const { id } = req.params;
    if (!isValidObjectId(id))
      return res.status(400).json({ message: "Invalid ID" });

    await Outage.findByIdAndDelete(id);
    res.json({ message: "Deleted" });
  } catch (err) {
    next(err);
  }
});

/* -------------------- Central Error Handler -------------------- */
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ message: "Server error" });
});

/* -------------------- Server -------------------- */
const PORT = process.env.PORT || 5000;
app.listen(PORT, () =>
  console.log(`Server running on port ${PORT}`)
);
