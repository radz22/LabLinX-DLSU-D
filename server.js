// ================== IMPORTS ==================
const sgMail = require('@sendgrid/mail');
const dotenv = require('dotenv');
const express = require('express');
const mongoose = require('mongoose');
const session = require('express-session');
const bcrypt = require('bcrypt');
const path = require('path');
const ws = require('ws');
const cors = require('cors');
const cron = require('node-cron'); // For scheduled reminders
const passport = require('passport'); // NEW: For OAuth
const MicrosoftStrategy = require('passport-microsoft').Strategy; // NEW: For

dotenv.config();

/**
 * @param {string} variableName
 * @returns {string}
 */
function ensureEnv(variableName) {
  const value = process.env[variableName];
  if (!value) {
    throw new Error(`Missing environment variable ${variableName}`);
  }
  return value;
}

// ================== EMAIL SETUP (using Nodemailer) ==================
// 🚨 ACTION REQUIRED: REPLACE THESE WITH YOUR OUTLOOK ACCOUNT DETAILS 🚨
const SENDGRID_FROM = ensureEnv('SENDGRID_FROM');
const ALLOWED_EMAIL_DOMAINS = (
  process.env.ALLOWED_EMAIL_DOMAINS || '@dlsud.edu.ph,@gmail.com'
)
  .split(',')
  .map((domain) => domain.trim().toLowerCase())
  .filter(Boolean);
const DATABASE_URL = ensureEnv('DATABASE_URL');
const DATABASE_NAME = process.env.DATABASE_NAME || 'lablinx';
const LOCAL_DATABASE_URL = process.env.LOCAL_DATABASE_URL;

function isEmailDomainAllowed(email) {
  if (!email) return false;
  const normalizedEmail = email.toLowerCase();
  return ALLOWED_EMAIL_DOMAINS.some((domain) =>
    normalizedEmail.endsWith(domain)
  );
}

sgMail.setApiKey(ensureEnv('SENDGRID_API_KEY'));

// ================== EMAIL HELPER FUNCTION ==================
const sendEmail = async (to, subject, htmlContent) => {
  try {
    const [response] = await sgMail.send({
      from: `LabLinx DLSU-D System <${SENDGRID_FROM}>`,
      to,
      subject,
      html: htmlContent,
    });

    if (response.statusCode >= 400) {
      console.error(
        `❌ Error sending email to ${to}: SendGrid responded with status ${response.statusCode}`
      );
      return;
    }

    console.log(`📧 Email sent to ${to}: ${subject}`);
  } catch (error) {
    console.error('❌ Unexpected error while sending email:', error);
  }
};

// ================== APP INIT ==================
const app = express();
const PORT = process.env.PORT || 3000;

// ================== MIDDLEWARE ==================
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors({ origin: true, credentials: true }));
app.use(
  session({
    secret: 'labsystem-secret-key-super-secure',
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false }, // Set to true if using HTTPS
  })
);
app.use(express.static(path.join(__dirname, 'public')));

// NEW: Passport Middleware
app.use(passport.initialize());
app.use(passport.session());

// ================== DB CONNECTION ==================
async function connectToDatabase() {
  try {
    await mongoose.connect(DATABASE_URL, { dbName: DATABASE_NAME });
    console.log('✅ MongoDB Connected Successfully');
    return;
  } catch (error) {
    console.error('❌ MongoDB Connection Error:', error);
  }

  if (!LOCAL_DATABASE_URL) {
    console.error('❌ LOCAL_DATABASE_URL not configured. Shutting down.');
    process.exit(1);
  }

  try {
    await mongoose.connect(LOCAL_DATABASE_URL, { dbName: DATABASE_NAME });
    console.log('✅ MongoDB Connected Successfully (Fallback)');
  } catch (fallbackError) {
    console.error('❌ Fallback MongoDB Connection Error:', fallbackError);
    process.exit(1);
  }
}

connectToDatabase();

// ================== SCHEMAS ==================
const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  firstName: { type: String, required: true },
  lastName: { type: String, required: true },
  studentID: { type: String, required: true, unique: true },
  email: { type: String, required: true, unique: true },
  gradeLevel: { type: String, required: true },
  // MODIFIED: Password is no longer required, to allow for student registration
  // without one. Admins will still have passwords.
  password: { type: String, required: false },
  role: { type: String, default: 'student' },
  status: { type: String, enum: ['Pending', 'Approved'], default: 'Pending' },
});

const inventorySchema = new mongoose.Schema({
  itemId: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  category: { type: String, required: true },
  quantity: { type: Number, required: true, min: 0 },
  originalQuantity: { type: Number, required: true, min: 0 },
  location: { type: String, required: true },
  // --- MODIFIED: ADDED 'Calibration' STATUS ---
  status: {
    type: String,
    enum: [
      'Available',
      'In-Use',
      'Maintenance',
      'Damaged', // Short for "Damaged - Awaiting Replacement"
      'Calibration', // <-- ADDED
      'Decommissioned', // Item is permanently removed
    ],
    default: 'Available',
  },
});

const requestSchema = new mongoose.Schema({
  itemId: { type: String, required: true },
  itemName: { type: String, required: true },
  studentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  studentName: { type: String, required: true },
  studentID: { type: String, required: true },
  quantity: { type: Number, required: true, min: 1 },
  startDate: { type: Date, required: true },
  dueDate: { type: Date, required: true },
  reason: { type: String, required: true },
  requestDate: { type: Date, default: Date.now },
  status: {
    type: String,
    enum: ['Pending', 'Approved', 'Rejected', 'Returned'],
    default: 'Pending',
  },
  category: { type: String, required: true },
  isDeleted: { type: Boolean, default: false }, // MODIFIED: Added for soft delete
  // --- NEW: Added return condition ---
  returnCondition: {
    type: String,
    enum: ['Good', 'Damaged', 'Lost'],
    default: 'Good',
  },
  damageNotes: { type: String }, // <-- ADDED to store notes from the return modal
});

// --- KEPT: SCHEMA FOR INCIDENTS (for Accountability Report) ---
const incidentSchema = new mongoose.Schema({
  // Info about the item that was damaged
  damagedItemInfo: {
    _id: { type: mongoose.Schema.Types.ObjectId, required: true },
    itemId: { type: String, required: true },
    name: { type: String, required: true },
    category: { type: String, required: true },
    modelName: { type: String, required: true }, // The Mongoose model name, e.g., 'ComputerInventory'
  },
  // The user responsible for replacement
  responsibleUser: {
    _id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    studentID: { type: String, required: true },
    studentName: { type: String, required: true },
  },
  // The loan/request that led to this incident
  originalTransaction: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ItemRequest',
    required: true,
  },

  // Tracking the resolution
  status: {
    type: String,
    enum: ['Pending Replacement', 'Resolved'],
    default: 'Pending Replacement',
  },
  damageNotes: { type: String }, // Admin's notes about the damage
  dateReported: { type: Date, default: Date.now },

  // Info about the resolution
  dateResolved: { type: Date },
  resolutionNotes: { type: String }, // Admin notes on how it was resolved (e.g., "User provided new item")
  replacementItemId: { type: String }, // The ID of the NEW item added to inventory
});

const reportHistorySchema = new mongoose.Schema({
  reportType: { type: String, required: true },
  generatedAt: { type: Date, default: Date.now },
  generatedBy: { type: String, required: true },
});

const notificationSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  title: { type: String, required: true },
  message: { type: String, required: true },
  isRead: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
});

const historySchema = new mongoose.Schema({
  adminUsername: { type: String, required: true },
  action: { type: String, required: true },
  details: { type: String, required: true },
  timestamp: { type: Date, default: Date.now },
});

const itemHistorySchema = new mongoose.Schema({
  itemId: { type: String, required: true, index: true },
  action: { type: String, required: true }, // e.g., 'Created', 'Borrowed', 'Returned', 'Returned (Damaged)'
  studentName: { type: String },
  studentID: { type: String },
  timestamp: { type: Date, default: Date.now },
});

const profileUpdateRequestSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  username: { type: String, required: true },
  currentFullName: { type: String, required: true },
  newFirstName: { type: String, required: true },
  newLastName: { type: String, required: true },
  newEmail: { type: String, required: true },
  status: {
    type: String,
    enum: ['Pending', 'Approved', 'Rejected'],
    default: 'Pending',
  },
  requestedAt: { type: Date, default: Date.now },
});

// --- User & Inventory Models ---
const User = mongoose.model('User', userSchema);
const ItemRequest = mongoose.model('ItemRequest', requestSchema);
const ReportHistory = mongoose.model('ReportHistory', reportHistorySchema);
const Notification = mongoose.model('Notification', notificationSchema);
const History = mongoose.model('History', historySchema);
const ItemHistory = mongoose.model('ItemHistory', itemHistorySchema);
const ProfileUpdateRequest = mongoose.model(
  'ProfileUpdateRequest',
  profileUpdateRequestSchema,
  'profile_update_requests'
);
const Inventory = mongoose.model('Inventory', inventorySchema, 'inventories');
const ScienceInventory = mongoose.model(
  'ScienceInventory',
  inventorySchema,
  'science_inventories'
);
const SportsInventory = mongoose.model(
  'SportsInventory',
  inventorySchema,
  'sports_inventories'
);
const FurnitureInventory = mongoose.model(
  'FurnitureInventory',
  inventorySchema,
  'furniture_inventories'
);
const ComputerInventory = mongoose.model(
  'ComputerInventory',
  inventorySchema,
  'computer_inventories'
);
const FoodLabInventory = mongoose.model(
  'FoodLabInventory',
  inventorySchema,
  'food_lab_inventories'
);
const RoboticsInventory = mongoose.model(
  'RoboticsInventory',
  inventorySchema,
  'robotics_inventories'
);
const MusicInventory = mongoose.model(
  'MusicInventory',
  inventorySchema,
  'music_inventories'
);
const Incident = mongoose.model('Incident', incidentSchema); // --- KEPT: Incident Model (for Accountability Report) ---

const allInventoryModels = [
  Inventory,
  ScienceInventory,
  SportsInventory,
  FurnitureInventory,
  ComputerInventory,
  FoodLabInventory,
  RoboticsInventory,
  MusicInventory,
];

// ===== HELPER FUNCTIONS FOR NOTIFICATIONS AND LOGS =====
const categoryAdminMap = {
  General: 'admin',
  'Office Supplies': 'admin',
  Science: 'admin2',
  Sports: 'admin2',
  'Tables & Chairs': 'admin3',
  'Computer Lab': 'admin3',
  'Food Lab': 'admin3',
  'Music Instruments': 'admin3',
  Robotics: 'admin4',
};

// NEW: Mapping of admin usernames to the categories they are allowed to manage.
const adminCategoryMapping = {
  admin: ['General', 'Office Supplies'],
  admin2: ['Science', 'Sports'],
  admin3: ['Tables &CChairs', 'Computer Lab', 'Food Lab', 'Music Instruments'],
  admin4: ['Robotics'],
};

const checkStockAndNotify = async (item) => {
  if (item && item.quantity === 0 && item.status === 'Available') {
    // Only notify if it just became 'Available'
    const adminUsername = categoryAdminMap[item.category];
    if (adminUsername) {
      const targetAdmin = await User.findOne({ username: adminUsername });
      if (targetAdmin) {
        const lowStockNotification = new Notification({
          userId: targetAdmin._id,
          title: 'Inventory Alert: Item Out of Stock',
          message: `The item "${item.name}" (ID: ${item.itemId}) is now out of stock.`,
        });
        await lowStockNotification.save();
      }
    }
  }
};

const logAdminAction = async (req, action, details) => {
  try {
    if (!req.session.user || req.session.user.role !== 'admin') return;
    const newLog = new History({
      adminUsername: req.session.user.username,
      action,
      details,
    });
    await newLog.save();
  } catch (error) {
    console.error(`History log failed: ${error.message}`);
  }
};

/// ================== CREATE DEFAULT ADMINS ==================
async function setupDefaultAdmins() {
  const saltRounds = 10;
  const admins = [
    {
      username: 'admin',
      password: 'admin123',
      firstName: 'General',
      lastName: 'Admin',
      studentID: '0000-ADMIN',
      email: 'admin@dlsud.edu.ph',
    },
    {
      username: 'admin2',
      password: 'admin456',
      firstName: 'Science',
      lastName: 'Admin',
      studentID: '0001-ADMIN',
      email: 'admin2@dlsud.edu.ph',
    },
    {
      username: 'admin3',
      password: 'admin789',
      firstName: 'Facility',
      lastName: 'Admin',
      studentID: '0002-ADMIN',
      email: 'admin3@dlsud.edu.ph',
    },
    {
      username: 'admin4',
      password: 'admin999',
      firstName: 'Robotics',
      lastName: 'Admin',
      studentID: '0003-ADMIN',
      email: 'admin4@dlsud.edu.ph',
    },
  ];

  for (const adminData of admins) {
    try {
      const adminExists = await User.findOne({
        studentID: adminData.studentID,
      });
      if (!adminExists) {
        const hashedPassword = await bcrypt.hash(
          adminData.password,
          saltRounds
        );
        const newAdmin = new User({
          ...adminData,
          password: hashedPassword,
          gradeLevel: 'N/A',
          role: 'admin',
          status: 'Approved',
        });
        await newAdmin.save();
        console.log(
          `👑 Default ${adminData.username} Created! Pass: ${adminData.password}`
        );
      } else {
        console.log(
          `✅ Admin ${adminData.username} already exists. Skipping creation.`
        );
      }
    } catch (error) {
      console.error(`❌ Error creating ${adminData.username}:`, error);
    }
  }
}
setupDefaultAdmins();

// ================== MIDDLEWARE & PAGE ROUTES ==================
// ================== MIDDLEWARE & PAGE ROUTES ==================

// ================== MIDDLEWARE & PAGE ROUTES ==================
const isAuthenticated = (req, res, next) => {
  if (req.session.user) return next();
  res.status(401).redirect('/');
};
const isAdmin = (req, res, next) => {
  if (req.session.user && req.session.user.role === 'admin') return next();
  res.status(403).json({ message: 'Access denied.' });
};
const isSuperAdmin = (req, res, next) => {
  // FIX #2: Make the username check case-insensitive to prevent auth failures.
  if (
    req.session.user &&
    req.session.user.username.toLowerCase() === 'admin2'
  ) {
    return next();
  }
  res.status(403).json({ message: 'Forbidden: Super admin access required.' });
};

app.get('/', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'login_register.html'))
);
app.get('/admin', isAuthenticated, (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'admin_panel.html'))
);
app.get('/admin2', isAuthenticated, (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'admin_panel2.html'))
);
app.get('/admin3', isAuthenticated, (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'admin_panel3.html'))
);
app.get('/admin4', isAuthenticated, (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'admin_panel4.html'))
);
app.get('/dashboard', isAuthenticated, (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'student_dashboard.html'))
);

// ================== AUTH ROUTES (WITH FACULTY FIX) ==================
// This is the /login route from server1.js, which handles password-less students
app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const user = await User.findOne({
      username: new RegExp(`^${username}$`, 'i'),
    });

    // MODIFIED: Check if user exists OR if they have no password (student)
    if (!user || !user.password) {
      return res
        .status(401)
        .send('Invalid credentials. Students must use Microsoft login.');
    }

    if (!(await bcrypt.compare(password, user.password))) {
      return res.status(401).send('Invalid credentials.');
    }

    if (user.status === 'Pending') {
      return res
        .status(403)
        .send('Your account is pending admin approval. You cannot log in yet.');
    }

    req.session.user = {
      id: user._id,
      username: user.username,
      role: user.role,
      fullName: `${user.firstName} ${user.lastName}`,
    };

    req.session.save((err) => {
      if (err) {
        console.error('Session save error:', err);
        return res.status(500).send('Server error during login.');
      }
      if (user.role === 'admin') {
        const adminUsername = user.username.toLowerCase();
        if (adminUsername === 'admin3') return res.redirect('/admin3');
        if (adminUsername === 'admin2') return res.redirect('/admin2');
        if (adminUsername === 'admin4') return res.redirect('/admin4');
        return res.redirect('/admin');
      } else if (user.role === 'student' || user.role === 'faculty') {
        // <-- Added faculty
        // This path is now unlikely for form login, but safe to keep.
        return res.redirect('/dashboard');
      } else {
        return res.status(403).send('Unknown user role.');
      }
    });
  } catch (error) {
    console.error('Login Error:', error);
    return res.status(500).send('Server error during login.');
  }
});

// THIS IS THE CORRECTED /register ROUTE
app.post('/register', async (req, res) => {
  try {
    // MODIFIED: Destructured 'role' from req.body
    const {
      lastName,
      firstName,
      username,
      studentID,
      email,
      gradeLevel,
      role,
    } = req.body;

    // ⬇️ NEW: Domain check added here to restrict registration email (from server.js)
    if (email && !isEmailDomainAllowed(email)) {
      return res
        .status(400)
        .send(
          `Registration failed: Email must end with any of the allowed domains (${ALLOWED_EMAIL_DOMAINS.join(
            ', '
          )}).`
        );
    }
    // ⬆️ NEW

    // MODIFIED: Added 'role' to the validation check
    if (
      !lastName ||
      !firstName ||
      !username ||
      !studentID ||
      !email ||
      !gradeLevel ||
      !role
    ) {
      return res.status(400).send('All fields are required.');
    }

    const existingUser = await User.findOne({
      $or: [
        { username: new RegExp(`^${username}$`, 'i') },
        { email: new RegExp(`^${email}$`, 'i') },
        { studentID: new RegExp(`^${studentID}$`, 'i') },
      ],
    });
    if (existingUser) {
      return res
        .status(409)
        .send('User with this Username, Email, or Student ID already exists.');
    }

    // MODIFIED: Removed password hashing

    // MODIFIED: 'role' now comes from req.body instead of being hardcoded
    const newUser = new User({
      lastName,
      firstName,
      username,
      studentID,
      email,
      gradeLevel, // This is correct, as faculty send 'N/A' from the front-end
      role: role, // <-- THIS IS THE FIX
      status: 'Pending',
    });
    await newUser.save();

    const superAdmin = await User.findOne({ username: 'admin2' });
    if (superAdmin) {
      const adminNotification = new Notification({
        userId: superAdmin._id,
        title: 'New User Registration',
        // MODIFIED: Send a generic "user" message
        message: `A new user, ${username} (Role: ${role}), has registered and is awaiting approval.`,
      });
      await adminNotification.save();
    }

    res
      .status(201)
      .send(
        'Registration successful! Your account is now pending for admin approval.'
      );
  } catch (error) {
    console.error('Registration Error:', error);
    res.status(500).send('Server error during registration.');
  }
});

// ================== START: LOGOUT ROUTE FIX ==================
// This route now conditionally handles local (admin) vs. Microsoft (student) logout
app.get('/logout', (req, res, next) => {
  // 1. Define the Microsoft logout URL for students
  const postLogoutRedirectUri = 'http://localhost:3000'; // Your app's home page
  const tenantID = MICROSOFT_TENANT_ID;
  const msLogoutUrl = `https://login.microsoftonline.com/${tenantID}/oauth2/v2.0/logout?post_logout_redirect_uri=${encodeURIComponent(
    postLogoutRedirectUri
  )}`;

  // 2. Check the user's role *before* destroying the session
  // MODIFIED: Also check for faculty
  const isStudentOrFaculty =
    req.session.user &&
    (req.session.user.role === 'student' ||
      req.session.user.role === 'faculty');

  // 3. Log out from Passport.js (clears any OAuth data)
  req.logout(function (err) {
    if (err) {
      console.error('Passport logout error:', err);
      return next(err);
    }

    // 4. Destroy the Express session
    req.session.destroy((err) => {
      if (err) {
        console.error('Session destruction error:', err);
        // Even if session destroy fails, try to redirect
      }

      // 5. Conditionally redirect
      if (isStudentOrFaculty) {
        // <-- MODIFIED
        // Students/Faculty logged in via Microsoft, so redirect them to Microsoft's logout
        res.redirect(msLogoutUrl);
      } else {
        // Admins (or other roles) logged in with a password, so just go to the local login page
        res.redirect('/');
      }
    });
  });
});
// ================== END: LOGOUT ROUTE FIX ==================

// ================== MICROSOFT OAUTH (from server1.js) ==================
const MICROSOFT_CLIENT_ID = ensureEnv('MICROSOFT_CLIENT_ID');
const MICROSOFT_CLIENT_SECRET = ensureEnv('MICROSOFT_CLIENT_SECRET');
const MICROSOFT_TENANT_ID = ensureEnv('MICROSOFT_TENANT_ID');
const CALLBACK_URL = ensureEnv('MICROSOFT_CALLBACK_URL');

passport.use(
  new MicrosoftStrategy(
    {
      clientID: MICROSOFT_CLIENT_ID,
      clientSecret: MICROSOFT_CLIENT_SECRET,
      callbackURL: CALLBACK_URL,
      scope: ['user.read'],
      tenant: MICROSOFT_TENANT_ID,
    },
    async (accessToken, refreshToken, profile, done) => {
      try {
        const email =
          profile.emails && profile.emails.length > 0
            ? profile.emails[0].value
            : null;
        if (!email) {
          return done(null, false, {
            message: 'No email returned from Microsoft.',
          });
        }

        const user = await User.findOne({
          email: new RegExp(`^${email}$`, 'i'),
        });

        if (!user) {
          return done(null, false, {
            message: 'This Microsoft account is not registered in our system.',
          });
        }

        if (user.status === 'Pending') {
          return done(null, false, {
            message: 'Your account is still pending admin approval.',
          });
        }

        return done(null, user);
      } catch (err) {
        return done(err);
      }
    }
  )
);

passport.serializeUser((user, done) => {
  done(null, user.id);
});

passport.deserializeUser(async (id, done) => {
  try {
    const user = await User.findById(id);
    done(null, user);
  } catch (err) {
    done(err);
  }
});

app.get(
  '/auth/microsoft',
  passport.authenticate('microsoft', {
    prompt: 'select_account',
  })
);

app.get(
  '/auth/microsoft/callback',
  passport.authenticate('microsoft', {
    failureRedirect: '/?error=ms_login_failed',
  }),
  (req, res) => {
    const user = req.user;

    req.session.user = {
      id: user._id,
      username: user.username,
      role: user.role,
      fullName: `${user.firstName} ${user.lastName}`,
    };

    req.session.save((err) => {
      if (err) {
        console.error('Session save error:', err);
        return res.status(500).send('Server error during login.');
      }

      if (user.role === 'admin') {
        const adminUsername = user.username.toLowerCase();
        if (adminUsername === 'admin3') return res.redirect('/admin3');
        if (adminUsername === 'admin2') return res.redirect('/admin2');
        if (adminUsername === 'admin4') return res.redirect('/admin4');
        return res.redirect('/admin');
      } else if (user.role === 'student' || user.role === 'faculty') {
        // <-- Added faculty
        return res.redirect('/dashboard');
      } else {
        return res.status(403).send('Unknown user role.');
      }
    });
  }
);

// === ACCOUNT UPDATE ROUTES ===
// This is the route from server.js (with domain validation)
app.post('/api/account/request-update', isAuthenticated, async (req, res) => {
  try {
    const { firstName, lastName, email } = req.body;

    // ⬇️ NEW: Domain check for profile update request
    if (email && !isEmailDomainAllowed(email)) {
      return res.status(400).json({
        message: `Update failed: Email must end with any of the allowed domains (${ALLOWED_EMAIL_DOMAINS.join(
          ', '
        )}).`,
      });
    }
    // ⬆️ NEW

    const userId = req.session.user.id;
    const user = await User.findById(userId);

    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    const existingPendingRequest = await ProfileUpdateRequest.findOne({
      userId,
      status: 'Pending',
    });
    if (existingPendingRequest) {
      return res.status(409).json({
        message: 'You already have a pending profile update request.',
      });
    }

    const newRequest = new ProfileUpdateRequest({
      userId,
      username: user.username,
      currentFullName: `${user.firstName} ${user.lastName}`,
      newFirstName: firstName,
      newLastName: lastName,
      newEmail: email,
    });

    await newRequest.save();

    const superAdmin = await User.findOne({ username: 'admin2' });
    if (superAdmin) {
      const adminNotification = new Notification({
        userId: superAdmin._id,
        title: 'Profile Update Request',
        message: `User ${user.username} has requested to update their profile.`, // MODIFIED
      });
      await adminNotification.save();
    }

    res.status(201).json({
      message:
        'Profile update request submitted successfully. It is now pending for admin approval.',
    });
  } catch (error) {
    if (error.code === 11000) {
      return res
        .status(409)
        .json({ message: 'This email is already in use by another account.' });
    }
    console.error('Profile Update Request Error:', error);
    res
      .status(500)
      .json({ message: 'Server error while submitting your request.' });
  }
});

// This is the route from server1.js (checks for password existence)
app.put('/api/account/password', isAuthenticated, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const userId = req.session.user.id;

    if (!currentPassword || !newPassword) {
      return res.status(400).send('Current and new passwords are required.');
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).send('User not found.');
    }

    // MODIFIED: Check if user has a password. If not, they can't use this feature.
    if (!user.password) {
      return res
        .status(403)
        .send(
          'Password cannot be changed for this account. Please use Microsoft login.'
        );
    }

    const isMatch = await bcrypt.compare(currentPassword, user.password);
    if (!isMatch) {
      return res.status(401).send('Incorrect current password.');
    }

    user.password = await bcrypt.hash(newPassword, 10);
    await user.save();

    res.send('Password updated successfully.');
  } catch (error) {
    console.error('Password Update Error:', error);
    res.status(500).send('Server error while updating password.');
  }
});

// ================== GENERIC CRUD FUNCTION ==================
const createCrudRoutes = (apiPath, Model) => {
  app.get(apiPath, isAuthenticated, async (req, res) => {
    try {
      // --- MODIFIED: Do not show Decommissioned items in main list ---
      const items = await Model.find({ status: { $ne: 'Decommissioned' } });
      res.json(items);
    } catch (e) {
      res.status(500).json({ message: 'Error fetching items.' });
    }
  });
  app.post(apiPath, isAdmin, async (req, res) => {
    try {
      if (await Model.findOne({ itemId: req.body.itemId })) {
        return res.status(409).json({ message: 'Item ID already exists.' });
      }
      const newItem = { ...req.body, originalQuantity: req.body.quantity };
      const savedItem = await new Model(newItem).save();
      await logAdminAction(
        req,
        'Create Item',
        `Created item '${savedItem.name}' (ID: ${savedItem.itemId})`
      );

      // Log item creation in its history
      await new ItemHistory({
        itemId: savedItem.itemId,
        action: 'Created',
      }).save();

      // 🔄 Broadcast refresh to all clients
      broadcastRefresh();

      res.status(201).json(savedItem);
    } catch (e) {
      res.status(500).json({ message: 'Error adding item.' });
    }
  });
  app.put(`${apiPath}/:itemId`, isAdmin, async (req, res) => {
    try {
      const item = await Model.findOne({ itemId: req.params.itemId });
      if (!item) return res.status(404).json({ message: 'Item not found.' });

      const updateData = { ...req.body };

      // --- MODIFIED: Handle quantity vs. status ---
      // If admin manually sets quantity (originalQuantity)
      if (updateData.originalQuantity !== undefined) {
        // We assume this is the *new total*
        const newTotal = parseInt(updateData.originalQuantity);
        updateData.originalQuantity = newTotal;

        // Recalculate 'available' quantity based on active loans
        const activeLoans = await ItemRequest.find({
          itemId: item.itemId,
          status: 'Approved',
        });
        const borrowedQty = activeLoans.reduce(
          (sum, req) => sum + req.quantity,
          0
        );

        updateData.quantity = newTotal - borrowedQty; // This is the new 'available'
      }

      // If admin manually sets status
      if (updateData.status && updateData.status !== item.status) {
        // If setting to 'Available' from 'Maintenance' or 'Damaged' or 'Calibration'
        if (
          updateData.status === 'Available' &&
          ['Maintenance', 'Damaged', 'Calibration'].includes(item.status)
        ) {
          // Assume it's the full original quantity becoming available
          updateData.quantity = item.originalQuantity;
        }
        // If setting to 'Maintenance' or 'Damaged' or 'Calibration'
        else if (
          ['Maintenance', 'Damaged', 'Calibration'].includes(updateData.status)
        ) {
          // Take it out of stock
          updateData.quantity = 0;
        }
      }
      // --- END MODIFICATION ---

      const updated = await Model.findOneAndUpdate(
        { itemId: req.params.itemId },
        { $set: updateData },
        { new: true }
      );
      await logAdminAction(
        req,
        'Update Item',
        `Updated item '${updated.name}' (ID: ${updated.itemId})`
      );

      // 🔄 Broadcast refresh to all clients
      broadcastRefresh();

      res.json(updated);
    } catch (e) {
      res.status(500).json({ message: 'Error updating item.' });
    }
  });
  app.delete(`${apiPath}/:itemId`, isAdmin, async (req, res) => {
    console.log(`DELETE called on ${apiPath}/${req.params.itemId}`); // Add this line
    try {
      // --- MODIFIED: This is now a soft delete (Archive) ---
      // const deleted = await Model.findOneAndDelete({ itemId: req.params.itemId });
      const deleted = await Model.findOneAndUpdate(
        { itemId: req.params.itemId },
        { $set: { status: 'Decommissioned', quantity: 0 } }, // Set status to Decommissioned
        { new: true }
      );

      if (!deleted) return res.status(404).json({ message: 'Item not found.' });
      await logAdminAction(
        req,
        'Archive Item',
        `Archived item '${deleted.name}' (ID: ${deleted.itemId})`
      );

      // Do NOT delete requests or history.
      // await ItemRequest.deleteMany({ itemId: req.params.itemId });
      // await ItemHistory.deleteMany({ itemId: req.params.itemId });

      // 🔄 Broadcast refresh to all clients
      broadcastRefresh();

      res.json({ message: 'Item archived.' }); // Changed message
    } catch (e) {
      res.status(500).json({ message: 'Error archiving item.' });
    }
  });
};

// ================== API ROUTES SETUP ==================
createCrudRoutes('/api/inventory', Inventory);
createCrudRoutes('/api/inventory2', ScienceInventory);
createCrudRoutes('/api/inventory3', SportsInventory);
createCrudRoutes('/api/inventory4', FurnitureInventory);
createCrudRoutes('/api/inventory5', ComputerInventory);
createCrudRoutes('/api/inventory6', FoodLabInventory);
createCrudRoutes('/api/inventory7', RoboticsInventory);
createCrudRoutes('/api/inventory8', MusicInventory);

// --- NEW: API ROUTES FOR ARCHIVED INVENTORY ---
// (These were in admin_panel3.html but not in server.js)
app.get('/api/archived-inventory', isAdmin, async (req, res) => {
  try {
    const adminUsername = req.session.user.username.toLowerCase();
    const allowedCategories = adminCategoryMapping[adminUsername];
    if (!allowedCategories) return res.json([]);

    let allArchived = [];
    for (const Model of allInventoryModels) {
      const items = await Model.find({
        category: { $in: allowedCategories },
        status: 'Decommissioned',
      });
      allArchived = allArchived.concat(items);
    }
    res.json(allArchived);
  } catch (e) {
    res.status(500).json({ message: 'Error fetching archived inventory.' });
  }
});

app.put('/api/inventory/restore/:itemId', isAdmin, async (req, res) => {
  try {
    const { item, Model } = await findModelAndItemForAdmin(
      req.params.itemId,
      req.session.user.username
    );
    if (!item)
      return res
        .status(404)
        .json({ message: 'Item not found in your categories.' });

    item.status = 'Available';
    item.quantity = item.originalQuantity; // Restore full quantity
    await item.save();

    await logAdminAction(
      req,
      'Restore Item',
      `Restored item '${item.name}' from archive.`
    );
    broadcastRefresh();
    res.json({ message: 'Item restored successfully.' });
  } catch (e) {
    res.status(500).json({ message: 'Error restoring item.' });
  }
});

app.delete('/api/inventory/permanent/:itemId', isAdmin, async (req, res) => {
  try {
    const { item, Model } = await findModelAndItemForAdmin(
      req.params.itemId,
      req.session.user.username
    );
    if (!item)
      return res
        .status(404)
        .json({ message: 'Item not found in your categories.' });

    // This is a REAL delete
    await Model.deleteOne({ itemId: req.params.itemId });

    // Also delete all related history
    await ItemRequest.deleteMany({ itemId: req.params.itemId });
    await ItemHistory.deleteMany({ itemId: req.params.itemId });
    await Incident.deleteMany({ 'damagedItemInfo.itemId': req.params.itemId });

    await logAdminAction(
      req,
      'Permanent Delete',
      `PERMANENTLY DELETED item '${item.name}' (ID: ${item.itemId}) and all related data.`
    );
    broadcastRefresh();
    res.json({ message: 'Item permanently deleted.' });
  } catch (e) {
    res.status(500).json({ message: 'Error permanently deleting item.' });
  }
});

// ================== STUDENT-FACING API ROUTES ==================
app.get('/api/current-user', isAuthenticated, async (req, res) => {
  try {
    const user = await User.findById(req.session.user.id)
      .select('-password')
      .lean();
    if (!user) return res.status(404).send('User not found');
    user.fullName = `${user.firstName} ${user.lastName}`;

    // --- NEW: Check for pending incidents ---
    const pendingIncident = await Incident.findOne({
      'responsibleUser._id': user._id,
      status: 'Pending Replacement',
    });
    user.hasPendingIncident = !!pendingIncident;
    if (pendingIncident) {
      user.pendingIncidentMessage = `You have an unresolved incident (Damaged Item: ${pendingIncident.damagedItemInfo.name}). Please see the lab admin.`;
    }
    // --- END NEW ---

    res.json(user);
  } catch (error) {
    res.status(500).send('Server error');
  }
});
app.get('/api/all-inventory', isAuthenticated, async (req, res) => {
  try {
    // --- MODIFIED: Do not show Maintenance, Damaged, Calibration, or Decommissioned items to students ---
    const findCriteria = { status: 'Available' };
    const inventories = await Promise.all(
      allInventoryModels.map((model) => model.find(findCriteria))
    );
    res.json([].concat(...inventories));
  } catch (e) {
    res.status(500).json({ message: 'Error fetching all inventories.' });
  }
});

app.post('/api/request-item', isAuthenticated, async (req, res) => {
  try {
    const { itemId, itemName, quantity, startDate, dueDate, reason, category } =
      req.body;
    const { id: studentId, fullName: studentName } = req.session.user;
    let itemModel = null;

    const user = await User.findById(studentId);
    if (!user) return res.status(404).send('Student not found.');

    // --- NEW: Block requests if user has a pending incident ---
    const pendingIncident = await Incident.findOne({
      'responsibleUser._id': user._id,
      status: 'Pending Replacement',
    });
    if (pendingIncident) {
      return res.status(403).json({
        message: `Request blocked: You have a pending accountability for a damaged item (${pendingIncident.damagedItemInfo.name}). Please see the lab admin.`,
      });
    }
    // --- END NEW ---

    for (const Model of allInventoryModels) {
      const itemToUpdate = await Model.findOne({ itemId });
      if (itemToUpdate) {
        itemModel = Model;
        break;
      }
    }
    if (!itemModel) return res.status(404).send('Item not found.');

    const existingRequest = await ItemRequest.findOne({
      studentId,
      itemId,
      status: { $in: ['Pending', 'Approved'] },
    });
    if (existingRequest)
      return res
        .status(409)
        .send('You already have an active request for this item.');

    const item = await itemModel.findOne({ itemId });
    if (!item) {
      return res.status(404).send('Item not found in inventory.');
    }
    if (item.quantity < quantity) {
      return res
        .status(409)
        .send('Failed to request item. Item may be out of stock.');
    }

    if (typeof item.originalQuantity === 'undefined') {
      item.originalQuantity = item.quantity;
    }

    // Do not decrease quantity here for 'Pending' requests. Only for direct borrowing.
    // item.quantity -= quantity;
    // if (item.quantity === 0 && item.status === 'Available') {
    //     item.status = 'In-Use';
    // }
    // await item.save();
    // await checkStockAndNotify(item);

    const newRequest = new ItemRequest({
      itemId,
      itemName,
      studentId,
      studentName,
      studentID: user.studentID,
      quantity,
      startDate,
      dueDate,
      reason,
      category,
    });
    await newRequest.save();

    const adminUsername = categoryAdminMap[category];
    if (adminUsername) {
      const targetAdmin = await User.findOne({ username: adminUsername });
      if (targetAdmin) {
        const adminNotification = new Notification({
          userId: targetAdmin._id,
          title: 'New Student Request', // This title is fine for faculty too
          message: `${studentName} requested ${quantity}x ${itemName}.`,
        });
        await adminNotification.save();
      }
    }

    // 🔄 Broadcast refresh to all clients
    broadcastRefresh();

    res.status(201).json(newRequest);
  } catch (e) {
    console.error('Request Error:', e);
    res.status(500).json({ message: 'Error creating request.' });
  }
});

app.get('/api/my-requests', isAuthenticated, async (req, res) => {
  try {
    const requests = await ItemRequest.find({
      studentId: req.session.user.id,
    }).sort({ requestDate: -1 });
    res.json(requests);
  } catch (e) {
    res.status(500).json({ message: 'Error fetching your requests.' });
  }
});

app.delete('/api/cancel-request/:id', isAuthenticated, async (req, res) => {
  try {
    const request = await ItemRequest.findOneAndDelete({
      _id: req.params.id,
      studentId: req.session.user.id,
      status: 'Pending',
    });
    if (!request)
      return res
        .status(404)
        .json({ message: 'Request not found or cannot be cancelled.' });

    // When cancelling a pending request, inventory doesn't need to be reverted as it was never taken.
    // await findAndUpdateItem(request.itemId, request.quantity);

    // 🔄 Broadcast refresh to all clients
    broadcastRefresh();

    res.json({ message: 'Request cancelled.' });
  } catch (e) {
    console.error('Cancellation Error:', e);
    res.status(500).json({ message: 'Error cancelling request.' });
  }
});

// ================== LIVE SCAN API ROUTES ==================
app.post('/api/borrow-by-barcode', isAdmin, async (req, res) => {
  try {
    const { itemId, studentID } = req.body;
    const adminUsername = req.session.user.username; // Get current admin

    const user = await User.findOne({ studentID });
    if (!user)
      return res
        .status(404)
        .json({ message: `User with ID ${studentID} not found.` }); // MODIFIED

    // --- NEW: Block borrow if user has a pending incident ---
    const pendingIncident = await Incident.findOne({
      'responsibleUser._id': user._id,
      status: 'Pending Replacement',
    });
    if (pendingIncident) {
      return res.status(403).json({
        message: `BORROW BLOCKED: User has a pending accountability for: ${pendingIncident.damagedItemInfo.name}.`,
      });
    }
    // --- END NEW ---

    // MODIFIED: Use the admin-aware function
    const item = await findItemInAllowedCategory(itemId, adminUsername);
    if (!item)
      return res.status(404).json({
        message: `Item with ID ${itemId} not found in your managed inventories.`,
      });
    if (item.quantity < 1)
      return res
        .status(400)
        .json({ message: `Item "${item.name}" is out of stock.` });

    // --- MODIFIED: Block borrowing of damaged/maintenance/calibration items ---
    if (item.status !== 'Available') {
      return res.status(400).json({
        message: `Item "${item.name}" is not available (Status: ${item.status}).`,
      });
    }
    // --- END MODIFICATION ---

    // MODIFIED: Use the admin-aware function
    const updatedItem = await findAndUpdateItemForAdmin(
      itemId,
      -1,
      adminUsername
    );
    await checkStockAndNotify(updatedItem);

    const startDate = new Date();
    const dueDate = new Date();
    dueDate.setDate(startDate.getDate() + 7);

    const newRequest = new ItemRequest({
      itemId,
      itemName: item.name,
      studentId: user._id,
      studentName: `${user.firstName} ${user.lastName}`,
      studentID: user.studentID,
      quantity: 1,
      startDate,
      dueDate,
      reason: 'Borrowed via Live Scan',
      status: 'Approved',
      category: item.category,
    });
    await newRequest.save();

    await new ItemHistory({
      itemId,
      action: 'Borrowed',
      studentName: newRequest.studentName,
      studentID: user.studentID,
    }).save();
    await logAdminAction(
      req,
      'Live Scan Borrow',
      `Item '${item.name}' borrowed by ${newRequest.studentName}.`
    );
    broadcastRefresh();
    res.json({
      message: `${item.name} successfully borrowed by ${newRequest.studentName}.`,
    });
  } catch (error) {
    console.error('Borrow by Barcode Error:', error);
    res
      .status(500)
      .json({ message: 'Server error during borrow transaction.' });
  }
});

// --- MODIFIED: /api/return-by-barcode ---
app.post('/api/return-by-barcode', isAdmin, async (req, res) => {
  try {
    // NEW: Get condition and notes from request body
    const { itemId, condition, damageNotes } = req.body;
    const adminUsername = req.session.user.username;

    const { item, Model } = await findModelAndItemForAdmin(
      itemId,
      adminUsername
    );
    if (!item)
      return res.status(404).json({
        message: `Item with ID ${itemId} not found in your managed inventories.`,
      });

    const request = await ItemRequest.findOne({
      itemId,
      status: 'Approved',
    }).sort({ requestDate: -1 });
    if (!request)
      return res
        .status(404)
        .json({ message: `No active loan found for item ID ${itemId}.` });

    request.status = 'Returned';

    // --- NEW LOGIC ---
    if (condition === 'Damaged' || condition === 'Lost') {
      // <-- ADDED 'Lost'
      request.returnCondition = condition;
      request.damageNotes = damageNotes; // <-- ADDED to save notes to the request
      await request.save();

      // 1. Mark item as Damaged, set quantity to 0
      item.status = 'Damaged';
      item.quantity = 0;
      await item.save();

      // 2. Create an Incident record
      const responsibleUser = await User.findById(request.studentId);
      const newIncident = new Incident({
        damagedItemInfo: {
          _id: item._id,
          itemId: item.itemId,
          name: item.name,
          category: item.category,
          modelName: Model.modelName, // e.g., "ComputerInventory"
        },
        responsibleUser: {
          _id: responsibleUser._id,
          studentID: responsibleUser.studentID,
          studentName: `${responsibleUser.firstName} ${responsibleUser.lastName}`,
        },
        originalTransaction: request._id,
        status: 'Pending Replacement',
        damageNotes: damageNotes,
      });
      await newIncident.save();

      // 3. Log history
      const action =
        condition === 'Lost' ? 'Returned (Lost)' : 'Returned (Damaged)';
      await new ItemHistory({
        itemId,
        action: action,
        studentName: request.studentName,
        studentID: request.studentID,
      }).save();
      await logAdminAction(
        req,
        `Live Scan Return (${condition})`,
        `Item '${request.itemName}' returned as ${condition} by ${request.studentName}. Incident created.`
      );

      broadcastRefresh();
      res.json({
        message: `${request.itemName} returned as ${condition}. Incident report created. User is pending replacement.`,
      });
    } else {
      // Condition is 'Good' or not specified
      request.returnCondition = 'Good';
      await request.save();

      // 1. Return item to stock (original logic)
      await findAndUpdateItemForAdmin(itemId, 1, adminUsername); // +1 quantity

      // 2. Log history
      await new ItemHistory({
        itemId,
        action: 'Returned',
        studentName: request.studentName,
        studentID: request.studentID,
      }).save();
      await logAdminAction(
        req,
        'Live Scan Return',
        `Item '${request.itemName}' returned by ${request.studentName}.`
      );

      broadcastRefresh();
      res.json({ message: `${request.itemName} successfully returned.` });
    }
    // --- END NEW LOGIC ---
  } catch (error) {
    console.error('Return by Barcode Error:', error);
    res
      .status(500)
      .json({ message: 'Server error during return transaction.' });
  }
});

app.get('/api/item-details/:itemId', isAdmin, async (req, res) => {
  try {
    const { itemId } = req.params;
    const adminUsername = req.session.user.username; // Get current admin

    // MODIFIED: Use the admin-aware function
    const item = await findItemInAllowedCategory(itemId, adminUsername);
    if (!item)
      return res
        .status(404)
        .json({ message: 'Item not found in your managed inventories.' });

    const currentLoan = await ItemRequest.findOne({
      itemId,
      status: 'Approved',
    }).sort({ requestDate: -1 });
    const history = await ItemHistory.find({ itemId })
      .sort({ timestamp: -1 })
      .limit(10);

    const responseData = { ...item.toObject(), currentLoan, history };

    res.json(responseData);
  } catch (error) {
    console.error('Fetch Item Details Error:', error);
    res.status(500).json({ message: 'Server error fetching item details.' });
  }
});

// --- REMOVED: INCIDENT MANAGEMENT API ROUTES ---

// ================== SUPER ADMIN API ROUTES ==================
app.get('/api/all-users', isAuthenticated, isSuperAdmin, async (req, res) => {
  try {
    const users = await User.find({}).select('-password');
    res.json(users);
  } catch (error) {
    res.status(500).json({ message: 'Error fetching user data.' });
  }
});

// This is the route from server1.js (handles optional password)
app.post('/api/users', isAuthenticated, isSuperAdmin, async (req, res) => {
  try {
    const {
      lastName,
      firstName,
      username,
      studentID,
      email,
      gradeLevel,
      password,
      role,
    } = req.body;
    const existingUser = await User.findOne({
      $or: [{ username }, { email }, { studentID }],
    });
    if (existingUser) {
      return res
        .status(409)
        .send('User with this Username, Email, or Student ID already exists.');
    }

    let hashedPassword = null;
    // MODIFIED: Only hash password if one is provided (for admins)
    if (password && role === 'admin') {
      hashedPassword = await bcrypt.hash(password, 10);
    }

    // MODIFIED: Status is 'Approved' for admins, 'Pending' for others
    const status = role === 'admin' ? 'Approved' : 'Pending';
    // MODIFIED: gradeLevel depends on role
    const finalGradeLevel = role === 'student' ? gradeLevel || 'N/A' : 'N/A';

    const newUser = new User({
      lastName,
      firstName,
      username,
      studentID,
      email,
      gradeLevel: finalGradeLevel,
      password: hashedPassword, // Will be null for students/faculty
      role,
      status,
    });
    await newUser.save();
    await logAdminAction(
      req,
      'Create User',
      `Created user '${username}' with role '${role}'.`
    );

    broadcastRefresh();
    res.status(201).json({ message: 'User created successfully.' });
  } catch (error) {
    res.status(500).send('Server error during user creation.');
  }
});

app.put(
  '/api/users/:id/role',
  isAuthenticated,
  isSuperAdmin,
  async (req, res) => {
    try {
      const { role } = req.body;
      const user = await User.findByIdAndUpdate(
        req.params.id,
        { role },
        { new: true }
      );
      if (!user) return res.status(404).send('User not found.');
      await logAdminAction(
        req,
        'Update User Role',
        `Changed role for '${user.username}' to '${role}'.`
      );
      res.json({ message: 'User role updated.' });
    } catch (error) {
      res.status(500).send('Error updating user role.');
    }
  }
);

app.put(
  '/api/users/:id/reset-password',
  isAuthenticated,
  isSuperAdmin,
  async (req, res) => {
    try {
      const { newPassword } = req.body;
      if (!newPassword)
        return res.status(400).send('New password is required.');

      const hashedPassword = await bcrypt.hash(newPassword, 10);
      const user = await User.findByIdAndUpdate(req.params.id, {
        password: hashedPassword,
      });
      if (!user) return res.status(404).send('User not found.');
      await logAdminAction(
        req,
        'Reset User Password',
        `Reset password for user '${user.username}'.`
      );

      // 🔄 Broadcast refresh to all clients
      broadcastRefresh();

      res.json({ message: 'User password reset successfully.' });
    } catch (error) {
      res.status(500).send('Error resetting password.');
    }
  }
);

app.delete(
  '/api/users/:id',
  isAuthenticated,
  isSuperAdmin,
  async (req, res) => {
    try {
      const user = await User.findByIdAndDelete(req.params.id);
      if (!user) return res.status(404).send('User not found.');
      await logAdminAction(
        req,
        'Delete User',
        `Deleted user '${user.username}'.`
      );

      // --- NEW: Also delete related incidents ---
      await Incident.deleteMany({ 'responsibleUser._id': user._id });

      // 🔄 Broadcast refresh to all clients
      broadcastRefresh();

      res.json({ message: 'User deleted successfully.' });
    } catch (error) {
      res.status(500).send('Error deleting user.');
    }
  }
);

app.get(
  '/api/profile-update-requests',
  isAuthenticated,
  isSuperAdmin,
  async (req, res) => {
    try {
      const requests = await ProfileUpdateRequest.find({
        status: 'Pending',
      }).sort({ requestedAt: -1 });
      res.json(requests);
    } catch (error) {
      res
        .status(500)
        .json({ message: 'Error fetching profile update requests.' });
    }
  }
);

app.put(
  '/api/profile-update-requests/:id/approve',
  isAuthenticated,
  isSuperAdmin,
  async (req, res) => {
    try {
      const request = await ProfileUpdateRequest.findById(req.params.id);
      if (!request || request.status !== 'Pending') {
        return res.status(404).json({
          message: 'Request not found or has already been processed.',
        });
      }

      const userToUpdate = await User.findByIdAndUpdate(
        request.userId,
        {
          firstName: request.newFirstName,
          lastName: request.newLastName,
          email: request.newEmail,
        },
        { new: true }
      );

      if (!userToUpdate) {
        request.status = 'Rejected';
        await request.save();
        return res.status(404).json({
          message: 'User to update not found. Request has been rejected.',
        });
      }

      request.status = 'Approved';
      await request.save();

      await logAdminAction(
        req,
        'Approve Profile Update',
        `Approved profile update for ${userToUpdate.username}.`
      );

      const studentNotification = new Notification({
        userId: request.userId,
        title: 'Profile Update Approved',
        message:
          'Your request to update your profile information has been approved.',
      });
      await studentNotification.save();

      // 🔄 Broadcast refresh to all clients
      broadcastRefresh();

      res.json({
        message: 'Profile update approved and user details updated.',
      });
    } catch (error) {
      res.status(500).json({ message: 'Server error during approval.' });
    }
  }
);

app.put(
  '/api/profile-update-requests/:id/reject',
  isAuthenticated,
  isSuperAdmin,
  async (req, res) => {
    try {
      const request = await ProfileUpdateRequest.findByIdAndUpdate(
        req.params.id,
        { status: 'Rejected' },
        { new: true }
      );
      if (!request) {
        return res.status(404).json({ message: 'Request not found.' });
      }

      await logAdminAction(
        req,
        'Reject Profile Update',
        `Rejected profile update for user ID ${request.userId}.`
      );

      const studentNotification = new Notification({
        userId: request.userId,
        title: 'Profile Update Rejected',
        message:
          'Your request to update your profile information has been rejected.',
      });
      await studentNotification.save();

      // 🔄 Broadcast refresh to all clients
      broadcastRefresh();

      res.json({ message: 'Profile update request rejected.' });
    } catch (error) {
      res.status(500).json({ message: 'Server error during rejection.' });
    }
  }
);

// NEW: Super Admin endpoints for registration requests
app.get(
  '/api/pending-registrations',
  isAuthenticated,
  isSuperAdmin,
  async (req, res) => {
    try {
      // MODIFIED: Find all non-admin pending users (students and faculty)
      const pendingUsers = await User.find({
        status: 'Pending',
        role: { $ne: 'admin' },
      }).sort({ _id: -1 });

      // --- 💥 FIX: REMOVED THIS LINE TO PREVENT INFINITE LOOP 💥 ---
      // broadcastRefresh();
      // --- END FIX ---

      res.json(pendingUsers);
    } catch (error) {
      res
        .status(500)
        .json({ message: 'Error fetching pending registrations.' });
    }
  }
);

// This is the route from server.js (with email notifications)
app.put(
  '/api/registrations/:userId/approve',
  isAuthenticated,
  isSuperAdmin,
  async (req, res) => {
    try {
      const user = await User.findByIdAndUpdate(
        req.params.userId,
        { status: 'Approved' },
        { new: true }
      );
      if (!user) {
        return res.status(4404).json({ message: 'User not found.' });
      }

      await logAdminAction(
        req,
        'Approve Registration',
        `Approved registration for user '${user.username}'.`
      );

      const studentNotification = new Notification({
        userId: user._id,
        title: 'Account Approved',
        message:
          'Welcome to LabLinx! Your registration has been approved, and you can now log in.',
      });
      await studentNotification.save();

      // NEW: Send account approval email
      if (user.email) {
        const emailSubject = '🎉 Your LabLinx Account Has Been Approved!';
        const emailBody = `
                <p>Hello ${user.firstName},</p>
                <p>We are pleased to inform you that your LabLinx DLSU-D account has been **APPROVED** by the administrator.</p>
                <p>You can now log in and start requesting laboratory equipment and materials.</p>
                <p><strong>Username:</strong> ${user.username}</p>
                <p>Click here to log in: <a href="http://localhost:${PORT}">Log In to LabLinx</a></p>
                <p><em>Thank you, LabLinx DLSU-D Team.</em></p>
            `;
        await sendEmail(user.email, emailSubject, emailBody);
      }

      // 🔄 Broadcast refresh to all clients
      broadcastRefresh();

      res.json({ message: `User ${user.username} has been approved.` });
    } catch (error) {
      res.status(500).json({ message: 'Server error during approval.' });
    }
  }
);

// This is the route from server.js (with email notifications)
app.delete(
  '/api/registrations/:userId/reject',
  isAuthenticated,
  isSuperAdmin,
  async (req, res) => {
    try {
      const user = await User.findByIdAndDelete(req.params.userId);
      if (!user) {
        return res.status(404).json({ message: 'User not found.' });
      }

      await logAdminAction(
        req,
        'Reject Registration',
        `Rejected and deleted registration for user '${user.username}'.`
      );

      // NEW: Send rejection email
      if (user.email) {
        const emailSubject = '🚫 LabLinx Account Registration Rejected';
        const emailBody = `
                  <p>Hello ${user.firstName},</p>
                  <p>We regret to inform you that your LabLinx DLSU-D account registration was **REJECTED** by the administrator. This may be due to incorrect information or missing details.</p>
                  <p>Please re-register with the correct information.</p>
                  <p><em>Thank you, LabLinx DLSU-D Team.</em></p>
             `;
        await sendEmail(user.email, emailSubject, emailBody);
      }

      // 🔄 Broadcast refresh to all clients
      broadcastRefresh();

      res.json({
        message: `Registration for ${user.username} has been rejected and deleted.`,
      });
    } catch (error) {
      res.status(500).json({ message: 'Server error during rejection.' });
    }
  }
);

// ================== ADMIN-FACING REQUEST API ROUTES (FILTERED) ==================
app.get('/api/admin-requests', isAdmin, async (req, res) => {
  try {
    const requests = await ItemRequest.find({
      category: { $in: ['General', 'Office Supplies'] },
      isDeleted: { $ne: true }, // MODIFIED: Exclude soft-deleted
    }).sort({ requestDate: -1 });
    res.json(requests);
  } catch (e) {
    res.status(500).json({ message: 'Error fetching requests for admin.' });
  }
});

app.get('/api/admin2-requests', isAdmin, async (req, res) => {
  try {
    const requests = await ItemRequest.find({
      category: { $in: ['Science', 'Sports'] },
      isDeleted: { $ne: true }, // MODIFIED: Exclude soft-deleted
    }).sort({ requestDate: -1 });
    res.json(requests);
  } catch (e) {
    res
      .status(500)
      .json({ message: 'Error fetching science and sports requests.' });
  }
});

app.get('/api/admin3-requests', isAdmin, async (req, res) => {
  try {
    const requests = await ItemRequest.find({
      category: {
        $in: [
          'Tables & Chairs',
          'Computer Lab',
          'Food Lab',
          'Music Instruments',
        ],
      },
      isDeleted: { $ne: true }, // MODIFIED: Exclude soft-deleted
    }).sort({ requestDate: -1 });
    res.json(requests);
  } catch (e) {
    res.status(500).json({ message: 'Error fetching admin3 requests.' });
  }
});

app.get('/api/admin-requests/Robotics', isAdmin, async (req, res) => {
  try {
    const requests = await ItemRequest.find({
      category: 'Robotics',
      isDeleted: { $ne: true }, // MODIFIED: Exclude soft-deleted
    }).sort({ requestDate: -1 });
    res.json(requests);
  } catch (e) {
    res.status(500).json({ message: 'Error fetching robotics requests.' });
  }
});

// NEW: Endpoint to get deleted requests for a specific admin's categories
app.get('/api/deleted-requests', isAdmin, async (req, res) => {
  try {
    const adminUsername = req.session.user.username.toLowerCase();
    const allowedCategories = adminCategoryMapping[adminUsername];
    if (!allowedCategories) {
      return res.json([]);
    }
    const requests = await ItemRequest.find({
      isDeleted: true,
      category: { $in: allowedCategories },
    }).sort({ requestDate: -1 });
    res.json(requests);
  } catch (e) {
    res.status(500).json({ message: 'Error fetching deleted requests.' });
  }
});

// ================== ADMIN-FACING REQUEST API ROUTES (EDITABLE) ==================
app.put('/api/edit-request/:id', isAdmin, async (req, res) => {
  try {
    const { quantity, ...otherUpdates } = req.body;
    const newQuantity = parseInt(quantity, 10);

    const request = await ItemRequest.findById(req.params.id);
    if (!request) {
      return res.status(404).json({ message: 'Request not found.' });
    }

    const oldQuantity = request.quantity;

    if (newQuantity && newQuantity !== oldQuantity) {
      const requestIsActive = ['Pending', 'Approved'].includes(request.status);

      if (requestIsActive) {
        // This logic is complex and might not apply to pending requests.
        // Re-evaluating for correctness. For now, assume this logic is for approved items.
      }
    }

    request.set({
      ...otherUpdates,
      quantity: newQuantity || oldQuantity,
    });

    await request.save();
    await logAdminAction(
      req,
      'Edit Request',
      `Edited details for request ID ${request._id} from student ${request.studentName}.`
    );

    // 🔄 Broadcast refresh to all clients
    broadcastRefresh();

    res.json({ message: 'Request updated successfully!', request });
  } catch (e) {
    console.error('Edit Request Error:', e);
    res.status(500).json({ message: 'Error updating request.' });
  }
});

// NEW: Soft delete a request
app.put('/api/requests/:id/delete', isAdmin, async (req, res) => {
  try {
    const request = await ItemRequest.findByIdAndUpdate(
      req.params.id,
      { isDeleted: true },
      { new: true }
    );
    if (!request)
      return res.status(404).json({ message: 'Request not found.' });
    await logAdminAction(
      req,
      'Delete Request',
      `Moved request ID ${request._id} for '${request.itemName}' to trash.`
    );
    broadcastRefresh();
    res.json({ message: 'Request moved to trash.' });
  } catch (e) {
    res.status(500).json({ message: 'Error deleting request.' });
  }
});

// NEW: Restore a request
app.put('/api/requests/:id/restore', isAdmin, async (req, res) => {
  try {
    const request = await ItemRequest.findByIdAndUpdate(
      req.params.id,
      { isDeleted: false },
      { new: true }
    );
    if (!request)
      return res.status(404).json({ message: 'Request not found.' });
    await logAdminAction(
      req,
      'Restore Request',
      `Restored request ID ${request._id} for '${request.itemName}'.`
    );
    broadcastRefresh();
    res.json({ message: 'Request restored successfully.' });
  } catch (e) {
    res.status(500).json({ message: 'Error restoring request.' });
  }
});

// NEW: Permanently delete a request
app.delete('/api/requests/:id/permanent', isAdmin, async (req, res) => {
  try {
    const request = await ItemRequest.findByIdAndDelete(req.params.id);
    if (!request)
      return res.status(404).json({ message: 'Request not found.' });
    await logAdminAction(
      req,
      'Permanent Delete Request',
      `Permanently deleted request ID ${request._id} for '${request.itemName}'.`
    );
    broadcastRefresh();
    res.json({ message: 'Request permanently deleted.' });
  } catch (e) {
    res.status(500).json({ message: 'Error permanently deleting request.' });
  }
});

// NEW: Helper to find an item and its model, but only if it's in an admin's allowed categories
const findModelAndItemForAdmin = async (itemId, adminUsername) => {
  const allowedCategories = adminCategoryMapping[adminUsername.toLowerCase()];
  if (!allowedCategories) return { item: null, Model: null };

  for (const Model of allInventoryModels) {
    const item = await Model.findOne({ itemId });
    if (item && allowedCategories.includes(item.category)) {
      return { item, Model };
    }
  }
  return { item: null, Model: null };
};

// NEW: Admin-aware version of findAndUpdateItem
const findAndUpdateItemForAdmin = async (itemId, change, adminUsername) => {
  const { item, Model } = await findModelAndItemForAdmin(itemId, adminUsername);
  if (!item) return null;

  if (typeof item.originalQuantity === 'undefined') {
    item.originalQuantity = item.quantity;
  }
  item.quantity += change;

  // Logic to prevent quantity from exceeding original on return
  if (change > 0 && item.quantity > item.originalQuantity) {
    item.quantity = item.originalQuantity;
  }

  // --- MODIFIED: Status update logic ---
  // Only set to 'Available' if it's not 'Maintenance' or 'Damaged' or 'Calibration'
  if (item.status === 'In-Use' && item.quantity > 0) {
    item.status = 'Available';
  }
  // Only set to 'In-Use' if it's 'Available' and quantity hits 0
  else if (item.status === 'Available' && item.quantity === 0) {
    item.status = 'In-Use';
  }
  // --- END MODIFICATION ---

  await item.save();
  return item;
};

// NEW: Admin-aware version of findItem
const findItemInAllowedCategory = async (itemId, adminUsername) => {
  const { item } = await findModelAndItemForAdmin(itemId, adminUsername);
  return item;
};

// This is the route from server.js (with email notifications)
app.put('/api/update-request/:id', isAdmin, async (req, res) => {
  const { status } = req.body;
  if (!['Approved', 'Rejected', 'Returned', 'Pending'].includes(status)) {
    return res.status(400).json({ message: 'Invalid status.' });
  }

  try {
    const request = await ItemRequest.findById(req.params.id);
    if (!request)
      return res.status(404).json({ message: 'Request not found.' });

    const originalStatus = request.status;
    if (originalStatus === status)
      return res.json({ message: 'Status is already set.', request });

    const wasPending = originalStatus === 'Pending';
    const isApproved = status === 'Approved';
    const isRejected = status === 'Rejected';
    const wasApproved = originalStatus === 'Approved';
    const isReturned = status === 'Returned';

    if (wasPending && isApproved) {
      const itemToUpdate = await findItemInAllowedCategory(
        request.itemId,
        req.session.user.username
      );
      if (!itemToUpdate || itemToUpdate.quantity < request.quantity) {
        return res.status(409).json({
          message: 'Cannot approve request. Insufficient stock available.',
        });
      }
      // --- NEW: Block approving damaged/maintenance/calibration items ---
      if (itemToUpdate.status !== 'Available') {
        return res.status(409).json({
          message: `Cannot approve request. Item is currently ${itemToUpdate.status}.`,
        });
      }
      // --- END NEW ---
      const updatedItem = await findAndUpdateItemForAdmin(
        request.itemId,
        -request.quantity,
        req.session.user.username
      );
      await checkStockAndNotify(updatedItem);
    } else if (wasApproved && isReturned) {
      // --- NEW: Check if item is damaged before returning to stock ---
      const item = await findItemInAllowedCategory(
        request.itemId,
        req.session.user.username
      );
      if (item && item.status !== 'Damaged' && item.status !== 'Calibration') {
        // <-- ADDED CALIBRATION CHECK
        await findAndUpdateItemForAdmin(
          request.itemId,
          request.quantity,
          req.session.user.username
        );
      } else if (
        item &&
        (item.status === 'Damaged' || item.status === 'Calibration')
      ) {
        // Item is unavailable, do not return to stock. It's already at 0.
        console.log(
          `Item ${item.itemId} was returned, but is ${item.status}. Not returning to stock.`
        );
      }
    }

    request.status = status;
    await request.save();

    await logAdminAction(
      req,
      'Update Request Status',
      `Set status for '${request.itemName}' (Student: ${request.studentName}) to '${status}'.`
    );

    const student = await User.findById(request.studentId);

    // --- STUDENT NOTIFICATION & EMAIL LOGIC ---
    const newNotification = new Notification({
      userId: request.studentId,
      title: `Request ${status}`,
      message: `Your request for "${
        request.itemName
      }" has been ${status.toLowerCase()}.`,
    });
    await newNotification.save();

    let emailSubject = '';
    let emailBody = '';

    if (student && student.email) {
      if (status === 'Approved') {
        const dueDateStr = new Date(request.dueDate).toLocaleDateString();
        emailSubject = `✅ Request Approved: ${request.itemName}`;
        emailBody = `
                    <p>Great news, ${student.firstName}!</p>
                    <p>Your request for <strong>${request.quantity}x ${request.itemName}</strong> has been **APPROVED**.</p>
                    <p>The due date for its return is **${dueDateStr}**.</p>
                    <p>Please proceed to the respective laboratory to claim your item(s).</p>
                    <p><em>Thank you, LabLinx DLSU-D Team.</em></p>
                `;
      } else if (status === 'Rejected') {
        emailSubject = `❌ Request Rejected: ${request.itemName}`;
        emailBody = `
                    <p>Hello ${student.firstName},</p>
                    <p>Your request for <strong>${request.quantity}x ${request.itemName}</strong> has been **REJECTED**.</p>
                    <p>Please check your LabLinx account for more details or submit a new request.</p>
                    <p><em>Thank you, LabLinx DLSU-D Team.</em></p>
                `;
      } else if (status === 'Returned') {
        emailSubject = `✅ Item Returned: ${request.itemName}`;
        emailBody = `
                    <p>Hello ${student.firstName},</p>
                    <p>Your item(s) <strong>${request.quantity}x ${request.itemName}</strong> has been marked as **RETURNED** successfully.</p>
                    <p>Thank you for using LabLinx.</p>
                    <p><em>LabLinx DLSU-D Team.</em></p>
                `;
      }

      if (emailSubject) {
        await sendEmail(student.email, emailSubject, emailBody);
      }
    }

    // 🔄 Broadcast refresh to all clients
    broadcastRefresh();

    res.json({ message: `Request status updated to ${status}.`, request });
  } catch (e) {
    console.error('Update Request Error:', e);
    res.status(500).json({ message: 'Error updating request status.' });
  }
});

// ================== NOTIFICATION & HISTORY API ROUTES ==================
app.get('/api/my-notifications', isAuthenticated, async (req, res) => {
  try {
    const notifications = await Notification.find({
      userId: req.session.user.id,
    }).sort({ createdAt: -1 });
    res.json(notifications);
  } catch (error) {
    res.status(500).send('Error fetching notifications');
  }
});

app.get('/api/admin/notifications', isAdmin, async (req, res) => {
  try {
    const notifications = await Notification.find({
      userId: req.session.user.id,
    }).sort({ createdAt: -1 });
    res.json(notifications);
  } catch (error) {
    res.status(500).send('Error fetching admin notifications');
  }
});

app.post('/api/notifications/mark-read', isAuthenticated, async (req, res) => {
  try {
    const result = await Notification.updateMany(
      { userId: req.session.user.id, isRead: false },
      { $set: { isRead: true } }
    );

    // Only broadcast if any notifications were updated
    if (result.modifiedCount > 0) {
      broadcastRefresh();
    }

    res.status(200).send('Notifications marked as read');
  } catch (error) {
    res.status(500).send('Error updating notifications');
  }
});

app.get('/api/admin/history', isAdmin, async (req, res) => {
  try {
    const historyLogs = await History.find({})
      .sort({ timestamp: -1 })
      .limit(100);
    res.json(historyLogs);
  } catch (e) {
    res.status(500).json({ message: 'Error fetching history logs.' });
  }
});

// ================== REPORT HISTORY API ROUTES ==================
app.post('/api/reports', isAdmin, async (req, res) => {
  try {
    const { reportType } = req.body;
    if (!reportType)
      return res.status(400).json({ message: 'Report type is required.' });

    const newReport = new ReportHistory({
      reportType,
      generatedBy: req.session.user.username,
    });
    await newReport.save();

    // MODIFIED: Also log this action in the main history log
    await logAdminAction(
      req,
      'Generate Report',
      `Generated a ${reportType} report.`
    );

    // 🔄 Broadcast refresh to all clients
    broadcastRefresh();

    res.status(201).json(newReport);
  } catch (e) {
    res.status(500).json({ message: 'Error saving report.' });
  }
});

app.get('/api/reports', isAdmin, async (req, res) => {
  try {
    const reports = await ReportHistory.find({}).sort({ generatedAt: -1 });
    res.json(reports);
  } catch (e) {
    res.status(500).json({ message: 'Error fetching reports.' });
  }
});

// ================== DUE DATE REMINDER SCHEDULER (from server.js) ==================
// This schedules a check to run every day at 8:00 AM (server timezone).
cron.schedule('0 0 8 * * *', async () => {
  // --- 1. DUE SOON REMINDER LOGIC (1-2 Days Before) ---
  // This runs a check every day for items due 1-2 days from now.

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const oneDayFromNow = new Date(today);
  oneDayFromNow.setDate(today.getDate() + 1); // Check for items due tomorrow

  const threeDaysFromNow = new Date(today);
  threeDaysFromNow.setDate(today.getDate() + 3); // Check for items due day after tomorrow (within 2 days)

  try {
    // Find approved requests due between 1 and 2 days from now (tomorrow and the day after)
    const dueSoonRequests = await ItemRequest.find({
      status: 'Approved',
      dueDate: { $gte: oneDayFromNow, $lt: threeDaysFromNow },
    })
      .populate('studentId', 'firstName email')
      .exec();

    for (const request of dueSoonRequests) {
      if (!request.studentId || !request.studentId.email) continue;

      const dueDateStr = new Date(request.dueDate).toLocaleDateString();
      const emailSubject = `⏰ ITEM DUE SOON: ${request.itemName} (Due: ${dueDateStr})`;
      const emailBody = `
                <p>Hello ${request.studentId.firstName},</p>
                <p>This is a friendly reminder that the item **${request.quantity}x ${request.itemName}** you borrowed is due between **1 to 2 days** from now on **${dueDateStr}**.</p>
                <p>Please prepare to return the item to the lab office soon.</p>
                <p><em>Thank you, LabLinx DLSU-D Team.</em></p>
            `;
      await sendEmail(request.studentId.email, emailSubject, emailBody);
    }
    console.log(
      `✅ Due Soon check complete. Sent ${dueSoonRequests.length} reminders.`
    );

    // --- 2. OVERDUE REMINDER LOGIC (Any time after Due Date) ---
    // This checks for items due any time before today and haven't been marked 'Returned'.

    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);

    // Find approved requests where the due date is before today (i.e., yesterday or earlier)
    const overdueRequests = await ItemRequest.find({
      status: 'Approved',
      dueDate: { $lt: today }, // Due date is less than the start of today
    })
      .populate('studentId', 'firstName email')
      .exec();

    for (const request of overdueRequests) {
      if (!request.studentId || !request.studentId.email) continue;

      const dueDateStr = new Date(request.dueDate).toLocaleDateString();
      const emailSubject = `🚨 URGENT: ITEM OVERDUE! (${request.itemName})`;
      const emailBody = `
                <p>Dear ${request.studentId.firstName},</p>
                <p>This is an **URGENT REMINDER** that the item **${request.quantity}x ${request.itemName}** was due on **${dueDateStr}** and is now **OVERDUE**.</p>
                <p>Please return it to the laboratory office immediately to avoid further penalties or account actions.</p>
                <p><em>LabLinx DLSU-D Team.</em></p>
            `;
      await sendEmail(request.studentId.email, emailSubject, emailBody);
    }
    console.log(
      `✅ Overdue check complete. Sent ${overdueRequests.length} overdue notices.`
    );

    if (dueSoonRequests.length > 0 || overdueRequests.length > 0) {
      broadcastRefresh();
    }
  } catch (error) {
    console.error('❌ Due Date Reminder Scheduler Error:', error);
  }
});

// ================== START SERVER ==================
const server = app.listen(PORT, () => {
  console.log(`🚀 Server is running at http://localhost:${PORT}`);
});

// ================== WEBSOCKET HANDLING ==================
const wss = new ws.Server({ server });

wss.on('connection', (socket) => {
  console.log('🔌 New WebSocket connection');

  socket.on('close', () => {
    console.log('❌ WebSocket connection closed');
  });
});

// Function to broadcast a refresh event
const broadcastRefresh = () => {
  console.log('Broadcasting refresh to all WebSocket clients'); // Add this line
  wss.clients.forEach((client) => {
    if (client.readyState === ws.OPEN) {
      client.send(JSON.stringify({ type: 'refresh' }));
    }
  });
};

// --- NEW: API ROUTE FOR USER ACCOUNTABILITY REPORT (FIXED PLACEMENT) ---
app.get(
  '/api/reports/user-accountability',
  isAuthenticated,
  isAdmin,
  async (req, res) => {
    try {
      const accountabilityReport = await ItemRequest.aggregate([
        {
          // Filter only for records where items have been returned
          $match: {
            status: 'Returned',
          },
        },
        {
          // Group by student and return condition
          $group: {
            _id: {
              studentId: '$studentId',
              studentName: '$studentName',
              returnCondition: '$returnCondition',
            },
            totalQuantity: { $sum: '$quantity' },
            totalRequests: { $sum: 1 },
          },
        },
        {
          // Group again by student to consolidate conditions
          $group: {
            _id: '$_id.studentId',
            studentName: { $first: '$_id.studentName' },
            // Pivot the data to get one document per student
            good: {
              $sum: {
                $cond: [
                  { $eq: ['$_id.returnCondition', 'Good'] },
                  '$totalQuantity',
                  0,
                ],
              },
            },
            damaged: {
              $sum: {
                $cond: [
                  { $in: ['$_id.returnCondition', ['Damaged', 'Lost']] },
                  '$totalQuantity',
                  0,
                ],
              },
            },
            // We only care about Damaged/Lost for accountability, but Good is useful context
            totalReturned: { $sum: '$totalQuantity' },
          },
        },
        {
          // Optionally look up pending incidents for the final student list
          $lookup: {
            from: 'incidents', // The name of the collection (mongoose model is 'Incident')
            localField: '_id',
            foreignField: 'responsibleUser._id',
            as: 'incidents',
          },
        },
        {
          // Final projection for the client
          $project: {
            _id: 0,
            studentId: '$_id',
            studentName: 1,
            good: 1,
            damaged: 1,
            totalReturned: 1,
            // Calculate pending incidents
            pendingIncidents: {
              $size: {
                $filter: {
                  input: '$incidents',
                  as: 'incident',
                  cond: { $eq: ['$$incident.status', 'Pending Replacement'] },
                },
              },
            },
          },
        },
        {
          $sort: { studentName: 1 }, // Sort alphabetically
        },
      ]);

      res.json(accountabilityReport);
    } catch (e) {
      console.error('User Accountability Report Error:', e);
      res
        .status(500)
        .json({ message: 'Error fetching user accountability report.' });
    }
  }
);
