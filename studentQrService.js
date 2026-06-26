const crypto = require('crypto');

const QR_PREFIX = 'EDUMANAGE';

function getQrSecret() {
  return process.env.JWT_SECRET || 'secret';
}

function buildStudentQrSignature(eleveId, matricule) {
  const normalized = String(matricule || '').trim().toUpperCase();
  return crypto
    .createHmac('sha256', getQrSecret())
    .update(`${QR_PREFIX}:ELEVE:${eleveId}:${normalized}`)
    .digest('hex')
    .slice(0, 20);
}

function buildStudentQrPayload(eleveId, matricule) {
  const m = String(matricule || '').trim();
  return JSON.stringify({
    v: 1,
    t: 'ELEVE',
    m,
    s: buildStudentQrSignature(eleveId, m),
  });
}

function parseStudentQrPayload(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return null;

  if (trimmed.startsWith('{')) {
    try {
      const data = JSON.parse(trimmed);
      if (data?.t === 'ELEVE' && data?.m && data?.s) return data;
    } catch {
      return null;
    }
  }

  return null;
}

async function verifyStudentQrLogin(prisma, findEleveByIdentifiant, raw) {
  const data = parseStudentQrPayload(raw);
  if (!data) {
    return {
      error: 'QR invalide. Utilisez le code QR de votre carte scolaire (connexion élève).',
      status: 400,
    };
  }

  const eleve = await findEleveByIdentifiant(data.m);
  if (!eleve?.utilisateur) {
    return { error: 'Élève introuvable ou sans compte actif.', status: 401 };
  }

  if (eleve.utilisateur.role !== 'ELEVE') {
    return { error: 'Ce QR code n\'est pas un espace élève.', status: 403 };
  }

  if (eleve.statut !== 'Actif') {
    return { error: 'Compte élève inactif.', status: 403 };
  }

  const expected = buildStudentQrSignature(eleve.id, eleve.matricule);
  if (data.s !== expected) {
    return { error: 'QR code non reconnu ou carte obsolète.', status: 401 };
  }

  return { eleve, user: eleve.utilisateur };
}

module.exports = {
  buildStudentQrPayload,
  parseStudentQrPayload,
  verifyStudentQrLogin,
};
