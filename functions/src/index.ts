/**
 * Import function triggers from their respective submodules:
 *
 * import {onCall} from "firebase-functions/v2/https";
 * import {onDocumentWritten} from "firebase-functions/v2/firestore";
 *
 * See a full list of supported triggers at https://firebase.google.com/docs/functions
 */

import {onCall, HttpsError} from "firebase-functions/v2/https";
import * as admin from "firebase-admin";

admin.initializeApp();

export const deleteManagedChild = onCall(async (request) => {
  const callerUid = request.auth?.uid;
  if (!callerUid) {
    throw new HttpsError("unauthenticated", "Connexion requise.");
  }

  const targetUid = (request.data?.targetUid || "").toString();
  if (!targetUid) {
    throw new HttpsError("invalid-argument", "Identifiant utilisateur requis.");
  }

  const db = admin.firestore();

  const callerSnap = await db.doc(`users/${callerUid}`).get();
  const caller = callerSnap.exists ? (callerSnap.data() as any) : null;
  if ((caller?.platformRole || "").toLowerCase() !== "admin") {
    throw new HttpsError("permission-denied", "Accès refusé.");
  }

  const targetSnap = await db.doc(`users/${targetUid}`).get();
  if (!targetSnap.exists) {
    throw new HttpsError("not-found", "Utilisateur introuvable.");
  }
  const target = targetSnap.data() as any;
  if (!target?.isManagedChild || target?.ownerUid !== callerUid) {
    throw new HttpsError("permission-denied", "Accès refusé.");
  }

  const usernameLower = target?.usernameLower || null;

  try {
    await admin.auth().deleteUser(targetUid);
  } catch (e: any) {
    const code = e?.code || "";
    if (code !== "auth/user-not-found") {
      throw new HttpsError("internal", "Impossible de supprimer l'utilisateur.");
    }
  }

  const batch = db.batch();
  if (usernameLower) batch.delete(db.doc(`usernames/${usernameLower}`));
  batch.delete(targetSnap.ref);
  await batch.commit();

  return {ok: true};
});
