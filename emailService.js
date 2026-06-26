const nodemailer = require('nodemailer');

function resolveSmtpConfig(settings = {}) {
  const host = process.env.SMTP_HOST || settings.smtp_host || 'smtp.gmail.com';
  const port = Number(process.env.SMTP_PORT || settings.smtp_port || 587);
  const secure = process.env.SMTP_SECURE === 'true' || Boolean(settings.smtp_secure);
  const user = (process.env.SMTP_USER || settings.smtp_user || '').trim();
  const pass = (process.env.SMTP_APP_PASSWORD || settings.smtp_app_password || '').trim();
  const enabled = process.env.MAIL_ENABLED === 'true' || Boolean(settings.mail_enabled);
  const from = (process.env.MAIL_FROM || user || settings.email_contact || '').trim();

  return { host, port, secure, user, pass, enabled, from };
}

function isSmtpConfigured(settings = {}) {
  const cfg = resolveSmtpConfig(settings);
  return cfg.enabled && Boolean(cfg.user) && Boolean(cfg.pass);
}

function sanitizeSettingsForClient(settings) {
  if (!settings) return settings;
  const { smtp_app_password, ...rest } = settings;
  return {
    ...rest,
    has_smtp_password: Boolean(smtp_app_password || process.env.SMTP_APP_PASSWORD),
  };
}

async function createTransporter(settings = {}) {
  const cfg = resolveSmtpConfig(settings);

  if (!cfg.enabled) {
    return { error: "L'envoi d'e-mails est désactivé. Activez-le dans Paramètres du site." };
  }
  if (!cfg.user || !cfg.pass) {
    return { error: 'Renseignez l\'e-mail expéditeur et le mot de passe d\'application SMTP.' };
  }

  const transporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: {
      user: cfg.user,
      pass: cfg.pass,
    },
  });

  try {
    await transporter.verify();
  } catch (err) {
    console.error('Erreur vérification SMTP:', err.message);
    return {
      error: 'Connexion SMTP échouée. Vérifiez l\'e-mail, le mot de passe d\'application (Gmail) et le port.',
      details: err.message,
    };
  }

  return { transporter, from: cfg.from || cfg.user, user: cfg.user };
}

async function sendEmail(prisma, { to, subject, text, html, replyTo }) {
  const settings = await prisma.parametreSite.findUnique({ where: { id: 1 } });
  const transport = await createTransporter(settings || {});
  if (transport.error) {
    return { ok: false, error: transport.error, details: transport.details };
  }

  const recipients = Array.isArray(to) ? to.join(', ') : to;
  if (!recipients) {
    return { ok: false, error: 'Destinataire manquant.' };
  }

  try {
    const info = await transport.transporter.sendMail({
      from: `"${settings?.nom_ecole || 'EduManage'}" <${transport.from}>`,
      to: recipients,
      replyTo: replyTo || undefined,
      subject,
      text,
      html: html || text.replace(/\n/g, '<br>'),
    });
    return { ok: true, messageId: info.messageId };
  } catch (err) {
    console.error('Erreur envoi e-mail:', err.message);
    return { ok: false, error: "Impossible d'envoyer l'e-mail.", details: err.message };
  }
}

async function sendContactEmail(prisma, { nom, email, message }) {
  const settings = await prisma.parametreSite.findUnique({ where: { id: 1 } });
  const to = settings?.email_contact || resolveSmtpConfig(settings).user;
  if (!to) {
    return { ok: false, error: "Aucun e-mail de contact configuré dans les paramètres du site." };
  }

  const subject = `[Contact site] Message de ${nom}`;
  const text = [
    `Nouveau message depuis le site web`,
    ``,
    `Nom : ${nom}`,
    `E-mail : ${email}`,
    ``,
    `Message :`,
    message,
  ].join('\n');

  return sendEmail(prisma, {
    to,
    subject,
    text,
    replyTo: email,
  });
}

async function sendTestEmail(prisma, to) {
  const settings = await prisma.parametreSite.findUnique({ where: { id: 1 } });
  const recipient = to || settings?.email_contact || resolveSmtpConfig(settings).user;
  if (!recipient) {
    return { ok: false, error: 'Indiquez un destinataire ou un e-mail de contact.' };
  }

  const subject = 'Test EduManage — configuration e-mail OK';
  const text = [
    'Ce message confirme que la configuration SMTP de EduManage fonctionne.',
    '',
    `Établissement : ${settings?.nom_ecole || 'GSP'}`,
    `Date : ${new Date().toLocaleString('fr-FR')}`,
  ].join('\n');

  return sendEmail(prisma, { to: recipient, subject, text });
}

function getAppLoginUrl() {
  const base = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');
  return `${base}/login`;
}

function getLoginUrlForRole(role) {
  const map = {
    ADMIN: 'admin',
    COMPTABLE: 'comptable',
    DIRECTEUR: 'directeur',
    PARENT: 'parent',
    ELEVE: 'eleve',
    PROFESSEUR: 'professeur',
  };
  const profil = map[role];
  const base = getAppLoginUrl();
  return profil ? `${base}?profil=${profil}` : base;
}

const ROLE_LABELS_FR = {
  ADMIN: 'Administrateur',
  COMPTABLE: 'Comptable',
  DIRECTEUR: 'Directeur',
  PROFESSEUR: 'Professeur',
  PARENT: 'Parent',
  ELEVE: 'Élève',
};

const INTERNAL_EMAIL_SUFFIXES = ['@gsp.local'];

function isDeliverableEmail(email) {
  const normalized = (email || '').trim().toLowerCase();
  if (!normalized || !normalized.includes('@')) return false;
  return !INTERNAL_EMAIL_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

function wrapAccountEmailHtml({ schoolName, title, bodyHtml }) {
  return `
<div style="font-family:Segoe UI,Arial,sans-serif;max-width:600px;margin:0 auto;color:#0f172a;">
  <div style="height:4px;background:linear-gradient(90deg,#c59b27,#e8c547,#c59b27);"></div>
  <div style="background:#0A2F6B;color:#fff;padding:20px 24px;">
    <h1 style="margin:0;font-size:18px;">${schoolName}</h1>
    <p style="margin:6px 0 0;font-size:13px;opacity:0.85;">${title}</p>
  </div>
  <div style="padding:24px;background:#fff;border:1px solid #e2e8f0;border-top:none;">
    ${bodyHtml}
  </div>
  <div style="padding:12px 24px;background:#f8fafc;border:1px solid #e2e8f0;border-top:none;font-size:12px;color:#94a3b8;text-align:center;">
    ${schoolName} · Plateforme EduManage
  </div>
</div>`;
}

function buildCredentialsBlock({ loginLabel, loginValue, password, loginUrl, showPassword = true }) {
  const passwordLine = showPassword && password
    ? `<p style="margin:0 0 8px;"><strong>Mot de passe :</strong> <code style="background:#fff;padding:2px 6px;border-radius:4px;">${password}</code></p>`
    : '';
  return `
<div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:16px;margin:16px 0;">
  <p style="margin:0 0 8px;"><strong>${loginLabel} :</strong> ${loginValue}</p>
  ${passwordLine}
  <p style="margin:0;"><strong>Connexion :</strong> <a href="${loginUrl}" style="color:#0A2F6B;">${loginUrl}</a></p>
</div>
<div style="text-align:center;margin:24px 0 8px;">
  <a href="${loginUrl}" style="display:inline-block;background:#0A2F6B;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;">Se connecter</a>
</div>`;
}

function buildAccountWelcomeContent({
  settings,
  role,
  nom,
  email,
  password,
  perimetre,
  eleve,
  linkedOnly = false,
  studentMatricule,
}) {
  const schoolName = settings?.nom_ecole || 'GSP Elhadj Mamadou Saïdou Diallo';
  const roleLabel = ROLE_LABELS_FR[role] || role;
  const loginUrl = getLoginUrlForRole(role);
  const greetingName = (nom || email || '').split(' ')[0] || 'Bonjour';

  let intro;
  let credentialsHtml = '';
  let credentialsText = [];
  let subject;

  if (role === 'PARENT' && linkedOnly && eleve) {
    subject = `[${schoolName}] Nouvel enfant lié à votre espace parent`;
    intro = `Votre espace parent a été associé à l'élève <strong>${eleve.prenom} ${eleve.nom}</strong> (matricule ${eleve.matricule}).`;
    credentialsText = [
      `Élève : ${eleve.prenom} ${eleve.nom}`,
      `Matricule : ${eleve.matricule}`,
      `Connexion : ${loginUrl}`,
    ];
    credentialsHtml = buildCredentialsBlock({
      loginLabel: 'E-mail',
      loginValue: email,
      loginUrl,
      showPassword: false,
    });
  } else if (role === 'ELEVE' && eleve) {
    subject = `[${schoolName}] Compte élève créé — ${eleve.prenom} ${eleve.nom}`;
    intro = `Le compte espace élève de <strong>${eleve.prenom} ${eleve.nom}</strong> a été créé.`;
    credentialsText = [
      `Identifiant (matricule) : ${studentMatricule || eleve.matricule}`,
      `Mot de passe : ${password}`,
      `Connexion : ${getLoginUrlForRole('ELEVE')}`,
    ];
    credentialsHtml = buildCredentialsBlock({
      loginLabel: 'Matricule',
      loginValue: studentMatricule || eleve.matricule,
      password,
      loginUrl: getLoginUrlForRole('ELEVE'),
    });
  } else {
    const roleDetail = role === 'DIRECTEUR' && perimetre ? ` — cycle ${perimetre}` : '';
    subject = `[${schoolName}] Vos identifiants ${roleLabel}${roleDetail} — EduManage`;
    intro = `Votre compte <strong>${roleLabel}${roleDetail}</strong> a été créé sur la plateforme EduManage.`;
    credentialsText = [
      `E-mail : ${email}`,
      `Mot de passe : ${password}`,
      `Connexion : ${loginUrl}`,
    ];
    credentialsHtml = buildCredentialsBlock({
      loginLabel: 'E-mail',
      loginValue: email,
      password,
      loginUrl,
    });
  }

  const text = [
    `Bonjour ${greetingName},`,
    '',
    intro.replace(/<[^>]+>/g, ''),
    '',
    '── Informations de connexion ──',
    ...credentialsText,
    '',
    'Conseil : modifiez votre mot de passe après la première connexion (menu « Mon profil »).',
    '',
    settings?.telephone ? `Secrétariat : ${settings.telephone}` : null,
    settings?.email_contact ? `Contact école : ${settings.email_contact}` : null,
    '',
    'Cordialement,',
    `L'administration — ${schoolName}`,
  ].filter(Boolean).join('\n');

  const html = wrapAccountEmailHtml({
    schoolName,
    title: subject.replace(`[${schoolName}] `, ''),
    bodyHtml: `
      <p>Bonjour <strong>${nom || greetingName}</strong>,</p>
      <p>${intro}</p>
      ${credentialsHtml}
      <p style="font-size:13px;color:#64748b;margin-top:20px;">
        Pensez à modifier votre mot de passe après votre première connexion.
      </p>`,
  });

  return { subject, text, html };
}

async function sendAccountWelcomeEmail(prisma, options) {
  const { email, password, linkedOnly } = options;
  const recipient = (email || '').trim().toLowerCase();

  if (!isDeliverableEmail(recipient)) {
    return { ok: false, skipped: true, error: 'Adresse e-mail non exploitable ou interne.' };
  }
  if (!linkedOnly && !password) {
    return { ok: false, error: 'Mot de passe manquant pour l\'e-mail de bienvenue.' };
  }

  const settings = await prisma.parametreSite.findUnique({ where: { id: 1 } });
  const { subject, text, html } = buildAccountWelcomeContent({ settings, ...options, email: recipient });

  return sendEmail(prisma, { to: recipient, subject, text, html });
}

function emailResponseMeta(result) {
  if (!result) return {};
  if (result.skipped) {
    return { emailSent: false, emailSkipped: true, emailError: result.error };
  }
  return {
    emailSent: Boolean(result.ok),
    emailError: result.ok ? undefined : result.error,
  };
}

function buildProfessorWelcomeContent({ settings, professeur, email, password }) {
  const schoolName = settings?.nom_ecole || 'GSP Elhadj Mamadou Saïdou Diallo';
  const loginUrl = getLoginUrlForRole('PROFESSEUR');
  const fullName = `${professeur.prenom} ${professeur.nom}`.trim();
  const matieres = professeur.matieres || [];
  const matieresLines = matieres.length
    ? matieres.map((m) => `• ${m.nom}${m.classe?.nom ? ` — ${m.classe.nom}` : ''}`)
    : ['• Aucune matière assignée pour le moment'];

  const text = [
    `Bonjour ${professeur.prenom},`,
    '',
    `Votre compte professeur a été créé sur la plateforme EduManage de ${schoolName}.`,
    '',
    '── Identifiants de connexion ──',
    `Adresse e-mail : ${email}`,
    `Mot de passe : ${password}`,
    `Lien de connexion : ${loginUrl}`,
    '',
    '── Votre profil ──',
    `Nom complet : ${fullName}`,
    professeur.specialite ? `Spécialité : ${professeur.specialite}` : null,
    professeur.contact ? `Téléphone : ${professeur.contact}` : null,
    `Rôle : Professeur`,
    '',
    '── Matières assignées ──',
    ...matieresLines,
    '',
    'Conseils :',
    '• Connectez-vous dès que possible et modifiez votre mot de passe depuis « Mon profil ».',
    '• Utilisez l\'espace « Mes Cours » pour saisir les notes de vos élèves.',
    '',
    settings?.telephone ? `Secrétariat : ${settings.telephone}` : null,
    settings?.email_contact ? `Contact école : ${settings.email_contact}` : null,
    settings?.adresse ? `Adresse : ${settings.adresse}` : null,
    '',
    'Cordialement,',
    `L'administration — ${schoolName}`,
  ].filter(Boolean).join('\n');

  const matieresHtml = matieres.length
    ? `<ul style="margin:8px 0;padding-left:20px;">${matieres.map((m) => `<li><strong>${m.nom}</strong>${m.classe?.nom ? ` <span style="color:#64748b;">(${m.classe.nom})</span>` : ''}</li>`).join('')}</ul>`
    : '<p style="margin:8px 0;color:#64748b;">Aucune matière assignée pour le moment.</p>';

  const html = `
<div style="font-family:Segoe UI,Arial,sans-serif;max-width:600px;margin:0 auto;color:#0f172a;">
  <div style="height:4px;background:linear-gradient(90deg,#c59b27,#e8c547,#c59b27);"></div>
  <div style="background:#0A2F6B;color:#fff;padding:20px 24px;">
    <h1 style="margin:0;font-size:18px;">${schoolName}</h1>
    <p style="margin:6px 0 0;font-size:13px;opacity:0.85;">Bienvenue sur EduManage — Espace Professeur</p>
  </div>
  <div style="padding:24px;background:#fff;border:1px solid #e2e8f0;border-top:none;">
    <p>Bonjour <strong>${professeur.prenom}</strong>,</p>
    <p>Votre compte professeur a été créé. Voici vos informations de connexion :</p>
    <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:16px;margin:16px 0;">
      <p style="margin:0 0 8px;"><strong>E-mail :</strong> ${email}</p>
      <p style="margin:0 0 8px;"><strong>Mot de passe :</strong> <code style="background:#fff;padding:2px 6px;border-radius:4px;">${password}</code></p>
      <p style="margin:0;"><strong>Connexion :</strong> <a href="${loginUrl}" style="color:#0A2F6B;">${loginUrl}</a></p>
    </div>
    <h3 style="font-size:14px;color:#0A2F6B;margin:20px 0 8px;">Votre profil</h3>
    <p style="margin:4px 0;"><strong>Nom :</strong> ${fullName}</p>
    ${professeur.specialite ? `<p style="margin:4px 0;"><strong>Spécialité :</strong> ${professeur.specialite}</p>` : ''}
    ${professeur.contact ? `<p style="margin:4px 0;"><strong>Téléphone :</strong> ${professeur.contact}</p>` : ''}
    <h3 style="font-size:14px;color:#0A2F6B;margin:20px 0 8px;">Matières assignées</h3>
    ${matieresHtml}
    <p style="font-size:13px;color:#64748b;margin-top:20px;">
      Pensez à modifier votre mot de passe après votre première connexion (menu « Mon profil »).
    </p>
    <div style="text-align:center;margin:24px 0 8px;">
      <a href="${loginUrl}" style="display:inline-block;background:#0A2F6B;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;">Se connecter</a>
    </div>
  </div>
  <div style="padding:12px 24px;background:#f8fafc;border:1px solid #e2e8f0;border-top:none;font-size:12px;color:#94a3b8;text-align:center;">
    ${schoolName} · Plateforme EduManage
  </div>
</div>`;

  return {
    subject: `[${schoolName}] Vos identifiants professeur — EduManage`,
    text,
    html,
  };
}

async function sendProfessorWelcomeEmail(prisma, { professeur, email, password }) {
  if (!isDeliverableEmail(email)) {
    return { ok: false, skipped: true, error: 'E-mail du professeur manquant ou non exploitable.' };
  }
  if (!password) {
    return { ok: false, error: 'Mot de passe manquant pour l\'e-mail de bienvenue.' };
  }

  const settings = await prisma.parametreSite.findUnique({ where: { id: 1 } });
  const { subject, text, html } = buildProfessorWelcomeContent({
    settings,
    professeur,
    email,
    password,
  });

  return sendEmail(prisma, {
    to: email.trim().toLowerCase(),
    subject,
    text,
    html,
  });
}

module.exports = {
  resolveSmtpConfig,
  isSmtpConfigured,
  sanitizeSettingsForClient,
  createTransporter,
  sendEmail,
  sendContactEmail,
  sendTestEmail,
  sendProfessorWelcomeEmail,
  sendAccountWelcomeEmail,
  emailResponseMeta,
  isDeliverableEmail,
  getAppLoginUrl,
  getLoginUrlForRole,
};
