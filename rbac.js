/**

 * Matrice RBAC — EduManage

 *

 * ADMIN      : tous niveaux — structure (niveaux, classes, années), staff (directeurs, comptable), CRUD total
 * COMPTABLE  : tous niveaux — inscriptions, élèves, comptes, finances (pas de notes)
 * DIRECTEUR  : un cycle — pédagogique (élèves lecture, notes, bulletins, matières & profs)
 */



const STAFF_ROLES = ['ADMIN', 'COMPTABLE', 'DIRECTEUR'];



const DIRECTEUR_CYCLES = ['Primaire', 'Collège', 'Lycée'];



const ROLE_PERMISSIONS = {

  ADMIN: ['*'],

  COMPTABLE: [

    'dashboard.read',

    'students.read',

    'students.write',

    'students.accounts',

    'classes.read',

    'years.read',

    'payments.read',

    'payments.write',

    'finance.reports',

    'finance.adjust',

  ],

  DIRECTEUR: [

    'dashboard.read',

    'students.read',

    'classes.read',

    'years.read',

    'subjects.read',

    'subjects.write',

    'teachers.read',

    'teachers.write',

    'grades.read',

    'grades.write',

    'bulletins.read',

    'bulletins.write',

  ],

};



function hasPermission(role, permission) {

  const perms = ROLE_PERMISSIONS[role];

  if (!perms) return false;

  if (perms.includes('*')) return true;

  return perms.includes(permission);

}



function isStaffRole(role) {

  return STAFF_ROLES.includes(role);

}



/** Mappe une route /api/admin/* vers une permission */

function permissionForAdminRoute(method, rawPath) {

  const path = (rawPath || '/').split('?')[0].replace(/\/+$/, '') || '/';

  const m = method.toUpperCase();



  if (path.startsWith('/users')) return 'users.manage';

  if (path.startsWith('/site-settings') || path.startsWith('/email')) return 'settings.manage';

  if (path.startsWith('/annonces')) return 'announcements.manage';

  if (path.startsWith('/notifications')) return 'notifications.manage';

  if (path.startsWith('/search')) return 'search.global';

  if (path.startsWith('/teacher-pay') || path.startsWith('/tarifs-horaires') || path.startsWith('/presences-professeurs') || path.startsWith('/remuneration')) {

    return 'teachers.pay';

  }

  if (path.match(/^\/classes\/\d+\/matieres/)) {

    return m === 'GET' ? 'subjects.read' : 'subjects.write';

  }

  if (path.startsWith('/professeurs')) {

    if (m === 'GET') return 'teachers.read';

    if (m === 'DELETE') return 'teachers.delete';

    return 'teachers.write';

  }

  if (path.startsWith('/matieres')) {

    if (m === 'GET') return 'subjects.read';

    if (m === 'DELETE') return 'subjects.delete';

    return 'subjects.write';

  }

  if (path.match(/^\/teachers/)) return 'teachers.manage';

  if (path.startsWith('/rapports/financiers')) return 'finance.reports';

  if (path.startsWith('/payments')) return 'payments.read';

  if (path.startsWith('/resultats') || path.includes('/results')) return 'bulletins.write';

  if (path.startsWith('/classes') && m !== 'GET') return 'classes.manage';

  if (path.startsWith('/classes')) return 'classes.read';

  if (path.startsWith('/niveaux') && m !== 'GET') return 'levels.manage';

  if (path.startsWith('/niveaux')) return 'levels.read';

  if (path.startsWith('/annees') && m !== 'GET') return 'years.manage';

  if (path.startsWith('/annees')) return 'years.read';

  if (path.startsWith('/notes') || path.startsWith('/grades')) {

    if (m === 'GET') return 'grades.read';

    return 'grades.write';

  }

  if (path.match(/^\/eleves\/\d+\/financier/)) return 'finance.adjust';

  if (path.match(/^\/eleves\/\d+\/compte/)) return 'students.accounts';

  if (path.match(/^\/eleves\/\d+\/reinscription/)) return 'students.write';

  if (path.match(/^\/eleves\/\d+\/statut/) && m !== 'GET') return 'students.delete';

  if (path.match(/^\/eleves\/\d+$/) && m === 'DELETE') return 'students.delete';

  if (path.match(/^\/eleves\/\d+$/) && m === 'PUT') return 'students.write';

  if (path.startsWith('/eleves') && m === 'POST') return 'students.write';

  if (path.startsWith('/eleves')) return 'students.read';

  if (path.startsWith('/inscriptions') && m !== 'GET') return 'students.write';

  if (path.startsWith('/stats') || path.startsWith('/chart-data') || path.startsWith('/recent-registrations') || path.startsWith('/taux-reussite')) {

    return 'dashboard.read';

  }

  if (path === '' || path === '/') return 'dashboard.read';



  return 'settings.manage';

}



function permissionForPaymentsRoute(method) {

  if (method.toUpperCase() === 'GET') return 'payments.read';

  return 'payments.write';

}



function canAccessAdminRoute(role, method, adminPath) {

  const permission = permissionForAdminRoute(method, adminPath);

  return hasPermission(role, permission);

}



function getDirecteurPerimetre(authUser) {

  if (authUser?.role === 'DIRECTEUR') return authUser.perimetre || null;

  return null;

}



function filterElevesByDirecteurCycle(eleves, perimetre) {

  if (!perimetre) return eleves;

  return eleves.filter((eleve) =>

    (eleve.inscriptions || []).some((ins) => ins.classe?.cycle === perimetre)

  );

}



function filterClassesByDirecteurCycle(classes, perimetre) {

  if (!perimetre) return classes;

  return classes.filter((c) => c.cycle === perimetre);

}



function filterNiveauxByDirecteurCycle(niveaux, perimetre) {

  if (!perimetre) return niveaux;

  return niveaux.filter((n) => n.cycle === perimetre);

}



function filterMatieresByDirecteurCycle(matieres, perimetre) {

  if (!perimetre) return matieres;

  return matieres.filter((m) => !m.classeId || m.classe?.cycle === perimetre);

}



function filterProfesseursByDirecteurCycle(profs, perimetre) {

  if (!perimetre) return profs;

  return profs

    .map((prof) => {

      const allMatieres = prof.matieres || [];

      const matieres = allMatieres.filter((m) => !m.classe || m.classe.cycle === perimetre);

      const hasInCycle = allMatieres.some((m) => m.classe?.cycle === perimetre);

      const hasOtherCycle = allMatieres.some((m) => m.classe && m.classe.cycle !== perimetre);

      const unassigned = allMatieres.length === 0;



      if (hasInCycle || unassigned || !hasOtherCycle) {

        return { ...prof, matieres };

      }

      return null;

    })

    .filter(Boolean);

}



function inscriptionWhereWithDirecteur(perimetre, where = {}) {

  if (!perimetre) return where;

  const existingClasse = where.classe && typeof where.classe === 'object' ? where.classe : {};

  return { ...where, classe: { ...existingClasse, cycle: perimetre } };

}



function cyclesForAuthUser(authUser) {

  const perimetre = getDirecteurPerimetre(authUser);

  return perimetre ? [perimetre] : DIRECTEUR_CYCLES;

}



module.exports = {

  STAFF_ROLES,

  DIRECTEUR_CYCLES,

  ROLE_PERMISSIONS,

  hasPermission,

  isStaffRole,

  permissionForAdminRoute,

  permissionForPaymentsRoute,

  canAccessAdminRoute,

  getDirecteurPerimetre,

  filterElevesByDirecteurCycle,

  filterClassesByDirecteurCycle,

  filterNiveauxByDirecteurCycle,

  filterMatieresByDirecteurCycle,

  filterProfesseursByDirecteurCycle,

  inscriptionWhereWithDirecteur,

  cyclesForAuthUser,

};


