const express = require('express');
const cors = require('cors');
const { PrismaClient } = require('@prisma/client');
const nodemailer = require('nodemailer');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
  }
});

// Map to store connected desktop agent sockets
// Key: employeeId, Value: socket.id
const userSockets = new Map();

io.on('connection', (socket) => {
  socket.on('identify', (employeeId) => {
    userSockets.set(employeeId, socket.id);
    console.log(`Desktop agent connected: Employee ${employeeId}`);
  });

  socket.on('disconnect', () => {
    // Remove the socket from the map on disconnect
    for (const [empId, socketId] of userSockets.entries()) {
      if (socketId === socket.id) {
        userSockets.delete(empId);
        console.log(`Desktop agent disconnected: Employee ${empId}`);
        break;
      }
    }
  });
});

const prisma = new PrismaClient();
const PORT = process.env.PORT || 3016;

app.use(cors());
app.use(express.json());

// Real SMTP service setup
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: process.env.SMTP_PORT || 587,
  secure: process.env.SMTP_PORT == 465, // true for 465, false for other ports
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

transporter.verify().then(() => {
  console.log('Real Email service connected and ready to send messages.');
}).catch(console.error);

// APIs

// Admin Auth
app.post('/api/admin/signup', async (req, res) => {
  const { email, password } = req.body;
  try {
    const existing = await prisma.admin.findUnique({ where: { email } });
    if (existing) return res.status(400).json({ error: 'Admin already exists' });
    const admin = await prisma.admin.create({ data: { email, password } });
    res.json({ message: 'Admin created successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error creating admin' });
  }
});

app.post('/api/admin/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const admin = await prisma.admin.findUnique({ where: { email } });
    if (!admin || admin.password !== password) return res.status(401).json({ error: 'Invalid credentials' });
    res.json({ message: 'Login successful' });
  } catch (err) {
    res.status(500).json({ error: 'Login error' });
  }
});

// Remote Action Endpoint
app.post('/api/admin/remote-action', async (req, res) => {
  const { employeeId, action } = req.body;

  if (!employeeId || !action) {
    return res.status(400).json({ error: 'Missing employeeId or action' });
  }

  const socketId = userSockets.get(employeeId);
  if (!socketId) {
    return res.status(404).json({ error: 'Employee desktop agent is not currently connected' });
  }

  // Emit the action to the specific employee's socket
  io.to(socketId).emit('remote-action', { action });
  console.log(`Sent remote action '${action}' to Employee ${employeeId}`);
  
  res.json({ message: `Action ${action} sent successfully` });
});

// Employee Auth
app.post('/api/employees/login', async (req, res) => {
  const { employeeId, password } = req.body;
  try {
    const emp = await prisma.employee.findUnique({ where: { id: employeeId } });
    if (!emp || emp.password !== password) return res.status(401).json({ error: 'Invalid ID or Password' });
    
    const sessionId = Date.now().toString() + Math.random().toString(36).substring(2);
    io.emit('force-logout', { employeeId: emp.id, activeSessionId: sessionId });

    res.json({ message: 'Login successful', employeeId: emp.id, hasChangedPassword: emp.hasChangedPassword, sessionId });
  } catch (err) {
    res.status(500).json({ error: 'Login error' });
  }
});

app.post('/api/employees/change-password', async (req, res) => {
  const { employeeId, newPassword } = req.body;
  try {
    await prisma.employee.update({
      where: { id: employeeId },
      data: { password: newPassword, hasChangedPassword: true }
    });
    res.json({ message: 'Password updated successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update password' });
  }
});

// Get all employees
app.get('/api/employees', async (req, res) => {
  const employees = await prisma.employee.findMany();
  res.json(employees);
});

// Add employee
app.post('/api/employees', async (req, res) => {
  const { name, email } = req.body;
  
  try {
    const existing = await prisma.employee.findUnique({ where: { email } });
    if (existing) {
      return res.status(400).json({ error: 'Employee with this email already exists' });
    }

    const id = Math.random().toString(36).substring(2, 7).toUpperCase();
    const tempPassword = Math.floor(100000 + Math.random() * 900000).toString(); // 6 digit PIN
    
    const employee = await prisma.employee.create({
      data: { id, name, email, password: tempPassword }
    });

    if (transporter) {
      transporter.sendMail({
        from: `"Admin System" <${process.env.SMTP_USER}>`,
        to: email,
        subject: 'Your Employee Portal Credentials',
        text: `Hello ${name},\n\nWelcome! Your Employee Portal credentials are:\n\nEmployee ID: ${id}\nTemporary Password: ${tempPassword}\n\nPlease login at https://app.subhadapolymers.in/`
      }).then(() => console.log(`Sent temporary password to ${email}`))
        .catch(err => console.error('Failed to send credentials email', err));
    }

    io.emit('data-update');
    res.json(employee);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to create employee' });
  }
});

// Get all leave requests
app.get('/api/leaves', async (req, res) => {
  const leaves = await prisma.leaveRequest.findMany({
    include: { employee: true }
  });
  res.json(leaves);
});

// Get leave requests for a specific employee
app.get('/api/leaves/employee/:employeeId', async (req, res) => {
  try {
    const leaves = await prisma.leaveRequest.findMany({
      where: { employeeId: req.params.employeeId },
      orderBy: { createdAt: 'desc' }
    });
    res.json(leaves);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch employee leaves' });
  }
});

// Submit a leave request
app.post('/api/leaves', async (req, res) => {
  const { employeeId, startDate, endDate, reason, leaveType, duration } = req.body;

  try {
    // Check if employee exists first
    const employee = await prisma.employee.findUnique({
      where: { id: employeeId }
    });

    if (!employee) {
      return res.status(404).json({ error: 'Invalid Employee ID. Please check and try again.' });
    }

    const leave = await prisma.leaveRequest.create({
      data: {
        employeeId: employeeId,
        startDate: new Date(startDate),
        endDate: new Date(endDate),
        leaveType: leaveType || 'FULL_DAY',
        duration: duration || null,
        reason,
        status: 'PENDING'
      },
      include: { employee: true }
    });

    // Admin email notification
    const formatDate = (d) => new Date(d).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'short', day: 'numeric' });
    const formattedStart = formatDate(startDate);
    const formattedEnd = formatDate(endDate);
    
    let durationText = `${formattedStart} ➔ ${formattedEnd}`;
    if (leaveType === 'HALF_DAY') {
      durationText = `${formattedStart} (Half Day - ${duration})`;
    } else if (leaveType === 'HOURLY') {
      durationText = `${formattedStart} (Hourly - ${duration} Hours)`;
    }

    if (transporter) {
      transporter.sendMail({
        from: `"Leave System" <${process.env.SMTP_USER}>`,
        to: process.env.ADMIN_EMAIL,
        subject: `New Leave Request from ${leave.employee.name}`,
        text: `${leave.employee.name} requested leave: ${durationText}. Reason: ${reason}. Approve: https://api.subhadapolymers.in/api/leaves/${leave.id}/approve?status=APPROVED`,
        html: `
          <div style="font-family: Arial, sans-serif; padding: 20px; border: 1px solid #e5e7eb; border-radius: 8px; max-width: 600px;">
            <h2 style="color: #333;">New Leave Request</h2>
            <p><b>Employee:</b> ${leave.employee.name} (ID: ${employeeId})</p>
            <p><b>Duration:</b> ${durationText}</p>
            <p style="padding: 10px; background-color: #f9fafb; border-left: 4px solid #4F46E5;"><b>Reason:</b> ${reason}</p>
            <div style="margin-top: 20px;">
              <a href="https://api.subhadapolymers.in/api/leaves/${leave.id}/approve?status=APPROVED" style="background-color: #22c55e; color: white; padding: 10px 20px; text-decoration: none; border-radius: 4px; font-weight: bold; margin-right: 10px;">Approve</a>
              <a href="https://api.subhadapolymers.in/api/leaves/${leave.id}/approve?status=REJECTED" style="background-color: #ef4444; color: white; padding: 10px 20px; text-decoration: none; border-radius: 4px; font-weight: bold;">Reject</a>
            </div>
          </div>
        `
      }).then(() => console.log('Real email sent to Admin successfully.'))
        .catch(err => console.error('Failed to send real email', err));
    }

    io.emit('data-update');
    res.json(leave);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create leave request' });
  }
});

// Approve/Reject leave via GET (for email links)
app.get('/api/leaves/:id/approve', async (req, res) => {
  const { id } = req.params;
  const { status } = req.query; // 'APPROVED' or 'REJECTED'
  const finalStatus = status || 'APPROVED';
  
  try {
    const leave = await prisma.leaveRequest.update({
      where: { id: id },
      data: { status: finalStatus },
      include: { employee: true }
    });
    
    // Send email to the employee
    const mailOptions = {
      from: process.env.SMTP_USER,
      to: leave.employee.email,
      subject: `Leave Request ${finalStatus}`,
      text: `Hello ${leave.employee.name},\n\nYour leave request from ${new Date(leave.startDate).toLocaleDateString()} to ${new Date(leave.endDate).toLocaleDateString()} has been ${finalStatus}.\n\nBest regards,\nAdmin`
    };
    
    transporter.sendMail(mailOptions)
      .then(() => console.log(`Notification email sent to ${leave.employee.email}`))
      .catch(console.error);
    
    // Quick return for email link clicks
    io.emit('data-update');
    res.send(`<h1>Leave has been ${finalStatus}</h1><p>The employee has been notified.</p><script>setTimeout(() => window.close(), 3000)</script>`);
  } catch (err) {
    console.error(err);
    res.status(500).send('Failed to process request');
  }
});

// Approve/Reject leave via PUT (for Admin UI)
app.put('/api/leaves/:id', async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  try {
    const leave = await prisma.leaveRequest.update({
      where: { id: id },
      data: { status },
      include: { employee: true }
    });

    const mailOptions = {
      from: process.env.SMTP_USER,
      to: leave.employee.email,
      subject: `Leave Request ${status}`,
      text: `Hello ${leave.employee.name},\n\nYour leave request from ${new Date(leave.startDate).toLocaleDateString()} to ${new Date(leave.endDate).toLocaleDateString()} has been ${status}.\n\nBest regards,\nAdmin`
    };
    
    transporter.sendMail(mailOptions).catch(console.error);

    io.emit('data-update');
    res.json(leave);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update leave status' });
  }
});

// Delete employee
app.delete('/api/employees/:id', async (req, res) => {
  const { id } = req.params;
  try {
    // Delete their leaves first (cascade)
    await prisma.leaveRequest.deleteMany({ where: { employeeId: id } });
    await prisma.employee.delete({ where: { id: id } });
    io.emit('data-update');
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete employee' });
  }
});

// Update employee
app.put('/api/employees/:id', async (req, res) => {
  const { id } = req.params;
  const { name, email, role } = req.body;
  try {
    const employee = await prisma.employee.update({
      where: { id: id },
      data: { name, email, role }
    });
    io.emit('data-update');
    res.json(employee);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update employee' });
  }
});

// Telemetry API for Desktop Agent
app.post('/api/telemetry/heartbeat', async (req, res) => {
  const { employeeId, status, systemBootTime, reason } = req.body;
  const today = new Date().toISOString().split('T')[0];

  try {
    // 1. Log the activity
    await prisma.activityLog.create({
      data: { 
        employeeId, 
        status, 
        tempReason: status === 'TEMP_ACTIVE' ? reason : null 
      }
    });

    // Upsert LiveTracking
    await prisma.liveTracking.upsert({
      where: { employeeId },
      update: {
        lastSeen: new Date(),
        lastActiveTime: status === 'ACTIVE' ? new Date() : undefined,
        status: status,
        tempReason: status === 'TEMP_ACTIVE' ? reason : null
      },
      create: {
        employeeId,
        lastSeen: new Date(),
        lastActiveTime: status === 'ACTIVE' ? new Date() : new Date(),
        status: status,
        tempReason: status === 'TEMP_ACTIVE' ? reason : null
      }
    });

    // 2. Process daily attendance
    let attendance = await prisma.attendance.findUnique({
      where: { employeeId_date: { employeeId, date: today } }
    });

    if (status === 'ACTIVE') {
      if (!attendance) {
        // First ping of the day, create attendance
        attendance = await prisma.attendance.create({
          data: {
            employeeId,
            date: today,
            clockIn: new Date(),
            systemBootTime: systemBootTime ? new Date(systemBootTime) : null,
            totalMinutes: 0
          }
        });
      } else if (attendance.clockOut) {
        // They came back online after being clocked out, resume
        await prisma.attendance.update({
          where: { id: attendance.id },
          data: { clockOut: null }
        });
      } else {
        // They were already active, increment their total worked minutes (assuming 1 ping per minute)
        await prisma.attendance.update({
          where: { id: attendance.id },
          data: { totalMinutes: { increment: 1 } }
        });
      }
    } else if (status === 'OFFLINE' || status === 'ADMIN_DECLINED') {
      if (attendance && !attendance.clockOut) {
        const liveRecord = await prisma.liveTracking.findUnique({ where: { employeeId } });
        await prisma.attendance.update({
          where: { id: attendance.id },
          data: { clockOut: liveRecord?.lastActiveTime || new Date() }
        });
      }
    } else if (status === 'TEMP_ACTIVE') {
      if (attendance) {
        await prisma.attendance.update({
          where: { id: attendance.id },
          data: { tempReason: reason }
        });
      }
    }
    // Note: If status === 'IDLE' or 'LOCKED', we do NOT clock them out immediately.

    // Tell all connected Admins that a live update just occurred
    io.emit('live-update');

    res.json({ success: true });
  } catch (err) {
    console.error('Telemetry error', err);
    res.status(500).json({ error: 'Failed to process telemetry' });
  }
});

// Telemetry endpoint for App Tracking
app.post('/api/telemetry/app', async (req, res) => {
  const { employeeId, appName, durationSec } = req.body;
  if (!employeeId || !appName || !durationSec) return res.status(400).json({ error: 'Missing data' });
  
  const today = new Date().toISOString().split('T')[0];
  try {
    const savedActivity = await prisma.appActivity.create({
      data: {
        employeeId,
        date: today,
        appName,
        durationSec
      }
    });
    
    // Broadcast real-time update
    io.emit('app-activity-update', savedActivity);
    
    res.json({ success: true });
  } catch (err) {
    console.error('App telemetry error', err);
    res.status(500).json({ error: 'Failed to process app telemetry' });
  }
});

// Admin Live Tracking Dashboard API
app.get('/api/attendance/live', async (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  try {
    const employees = await prisma.employee.findMany();
    
    // Get all attendances for today
    const attendances = await prisma.attendance.findMany({
      where: { date: today }
    });

    // Get the latest activity for each employee
    const latestActivities = await prisma.activityLog.groupBy({
      by: ['employeeId'],
      _max: { timestamp: true }
    });

    // We need to fetch the actual status for those latest timestamps
    const activityStatuses = {};
    for (const act of latestActivities) {
      if(act._max.timestamp) {
        const fullAct = await prisma.activityLog.findFirst({
          where: { employeeId: act.employeeId, timestamp: act._max.timestamp }
        });
        if(fullAct) {
          // If the last activity was more than 3 minutes ago, assume OFFLINE (agent crashed/disconnected)
          const isStale = (new Date() - new Date(fullAct.timestamp)) > (3 * 60 * 1000);
          activityStatuses[act.employeeId] = isStale ? 'OFFLINE' : fullAct.status;
        }
      }
    }

    const liveData = employees.map(emp => {
      const att = attendances.find(a => a.employeeId === emp.id);
      return {
        id: emp.id,
        name: emp.name,
        employeeId: emp.employeeId,
        department: emp.department,
        status: activityStatuses[emp.id] || 'OFFLINE',
        clockIn: att?.clockIn || null,
        clockOut: att?.clockOut || null,
        totalMinutes: att?.totalMinutes || 0
      };
    });

    res.json(liveData);
  } catch (err) {
    console.error('Failed to get live data', err);
    res.status(500).json({ error: 'Failed to fetch live data' });
  }
});

// Admin Detailed Timeline API
app.get('/api/attendance/employee/:id', async (req, res) => {
  const { id } = req.params;
  const dateStr = req.query.date || new Date().toISOString().split('T')[0];
  try {
    const employee = await prisma.employee.findUnique({ where: { id } });
    if (!employee) return res.status(404).json({ error: 'Not found' });
    
    const attendance = await prisma.attendance.findUnique({
      where: { employeeId_date: { employeeId: id, date: dateStr } }
    });

    const startOfDay = new Date(dateStr);
    startOfDay.setUTCHours(0, 0, 0, 0);
    const endOfDay = new Date(dateStr);
    endOfDay.setUTCHours(23, 59, 59, 999);

    const activities = await prisma.activityLog.findMany({
      where: {
        employeeId: id,
        timestamp: {
          gte: startOfDay,
          lte: endOfDay
        }
      },
      orderBy: { timestamp: 'desc' } // INVERTED: newest on top
    });

    // Filter consecutive duplicate statuses to build a clean timeline
    const timeline = [];
    let lastStatus = null;
    
    // Because it's inverted (newest first), we only push when it differs from the *previous* (which is chronologically next)
    for (const act of activities) {
      if (act.status !== lastStatus) {
        timeline.push(act);
        lastStatus = act.status;
      }
    }

    const appActivities = await prisma.appActivity.findMany({
      where: { employeeId: id, date: dateStr },
      orderBy: { timestamp: 'desc' }
    });

    res.json({
      employee: { name: employee.name, department: employee.department, employeeId: employee.employeeId },
      attendance,
      timeline,
      appActivities
    });
  } catch (err) {
    console.error('Failed to get timeline', err);
    res.status(500).json({ error: 'Failed to fetch timeline data' });
  }
});

// Admin Daily Attendance Log API
app.get('/api/attendance/daily', async (req, res) => {
  const dateStr = req.query.date || new Date().toISOString().split('T')[0];
  try {
    const employees = await prisma.employee.findMany();
    const attendances = await prisma.attendance.findMany({
      where: { date: dateStr }
    });

    const approvedLeaves = await prisma.leaveRequest.findMany({
      where: { status: 'APPROVED' }
    });

    const isOverlapping = (leave, dateStr) => {
      const s = new Date(leave.startDate);
      s.setUTCHours(12, 0, 0, 0); // Shift to middle of day to ignore UTC offset bugs
      const e = new Date(leave.endDate);
      e.setUTCHours(12, 0, 0, 0);
      
      const target = new Date(dateStr);
      target.setUTCHours(12, 0, 0, 0);
      
      return s <= target && e >= target;
    };

    const dailyData = employees.map(emp => {
      const att = attendances.find(a => a.employeeId === emp.id);
      const leave = approvedLeaves.find(l => l.employeeId === emp.id && isOverlapping(l, dateStr));
      return {
        id: emp.id,
        name: emp.name,
        employeeId: emp.employeeId,
        department: emp.department,
        clockIn: att?.clockIn || null,
        clockOut: att?.clockOut || null,
        systemBootTime: att?.systemBootTime || null,
        tempReason: att?.tempReason || null,
        totalMinutes: att?.totalMinutes || 0,
        onLeave: !!leave,
        leaveType: leave ? leave.leaveType : null
      };
    });

    res.json(dailyData);
  } catch (err) {
    console.error('Failed to get daily attendance', err);
    res.status(500).json({ error: 'Failed to fetch daily attendance' });
  }
});

// Admin Monthly Attendance Log API
app.get('/api/attendance/monthly', async (req, res) => {
  const monthStr = req.query.month; // e.g. "2023-10"
  if (!monthStr) return res.status(400).json({ error: 'Month parameter is required' });

  try {
    const employees = await prisma.employee.findMany();
    const attendances = await prisma.attendance.findMany({
      where: { date: { startsWith: monthStr } },
      orderBy: { date: 'asc' }
    });

    const appActivities = await prisma.appActivity.findMany({
      where: { date: { startsWith: monthStr } }
    });

    const monthlyData = [];

    const formatDuration = (secs) => {
      if (secs < 60) return `${secs}s`;
      const m = Math.floor(secs / 60);
      if (m < 60) return `${m}m ${secs % 60}s`;
      const h = Math.floor(m / 60);
      return `${h}h ${m % 60}m`;
    };

    for (const att of attendances) {
      const emp = employees.find(e => e.id === att.employeeId);
      if (!emp) continue;

      const appsForDay = appActivities.filter(a => a.employeeId === att.employeeId && a.date === att.date);
      
      const appMap = {};
      for (const a of appsForDay) {
        if (!appMap[a.appName]) appMap[a.appName] = 0;
        appMap[a.appName] += a.durationSec;
      }
      
      const appStrings = Object.entries(appMap)
        .sort((a, b) => b[1] - a[1])
        .map(([appName, duration]) => `${appName} (${formatDuration(duration)})`);
      
      const appUsageStr = appStrings.join(', ') || 'No app usage recorded';

      monthlyData.push({
        id: emp.id,
        name: emp.name,
        employeeId: emp.employeeId,
        department: emp.department,
        date: att.date,
        clockIn: att.clockIn,
        clockOut: att.clockOut,
        systemBootTime: att.systemBootTime,
        totalMinutes: att.totalMinutes,
        appUsageStr: appUsageStr
      });
    }

    res.json(monthlyData);
  } catch (err) {
    console.error('Failed to get monthly attendance', err);
    res.status(500).json({ error: 'Failed to fetch monthly attendance' });
  }
});

// Delete leave
app.delete('/api/leaves/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await prisma.leaveRequest.delete({ where: { id: id } });
    io.emit('data-update');
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete leave' });
  }
});

// Get single employee
app.get('/api/employees/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const employee = await prisma.employee.findUnique({ where: { id: id } });
    if (!employee) return res.status(404).json({ error: 'Employee not found' });
    res.json({ name: employee.name, email: employee.email });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch employee' });
  }
});

// Update password (requires old password)
app.post('/api/employees/update-password', async (req, res) => {
  const { employeeId, oldPassword, newPassword } = req.body;
  try {
    const employee = await prisma.employee.findUnique({ where: { id: employeeId } });
    if (!employee) return res.status(404).json({ error: 'Employee not found' });
    
    if (employee.password !== oldPassword) {
      return res.status(401).json({ error: 'Incorrect old password' });
    }
    
    await prisma.employee.update({
      where: { id: employeeId },
      data: { password: newPassword }
    });
    
    res.json({ message: 'Password updated successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update password' });
  }
});

// Auto-Logout Cron Job (Runs every 5 minutes)
setInterval(async () => {
  try {
    const cutoff = new Date(Date.now() - 5 * 60 * 1000); // 5 minutes ago
    const offlineEmployees = await prisma.liveTracking.findMany({
      where: {
        status: { in: ['ACTIVE', 'IDLE', 'LOCKED'] },
        lastSeen: { lt: cutoff }
      }
    });

    if (offlineEmployees.length > 0) {
      for (const emp of offlineEmployees) {
        // 1. Mark as OFFLINE
        await prisma.liveTracking.update({
          where: { employeeId: emp.employeeId },
          data: { status: 'OFFLINE' }
        });

        // 2. Backdate ClockOut
        const today = new Date().toISOString().split('T')[0];
        const attendance = await prisma.attendance.findUnique({
          where: { employeeId_date: { employeeId: emp.employeeId, date: today } }
        });

        if (attendance && !attendance.clockOut) {
          await prisma.attendance.update({
            where: { id: attendance.id },
            data: { clockOut: emp.lastActiveTime || emp.lastSeen }
          });
        }
      }
      io.emit('live-update');
    }

    // Midnight Rollover Check (Check if it's 23:58 or 23:59 to close out the day)
    const now = new Date();
    if (now.getHours() === 23 && now.getMinutes() >= 55) {
      const today = now.toISOString().split('T')[0];
      const openAttendances = await prisma.attendance.findMany({
        where: { date: today, clockOut: null }
      });
      for (const att of openAttendances) {
        const liveRecord = await prisma.liveTracking.findUnique({ where: { employeeId: att.employeeId } });
        await prisma.attendance.update({
          where: { id: att.id },
          data: { clockOut: liveRecord?.lastActiveTime || new Date() }
        });
      }
    }

  } catch (err) {
    console.error('Auto-Logout Cron Error:', err);
  }
}, 5 * 60 * 1000);

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
