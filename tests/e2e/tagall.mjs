// Turn a single-department seed into one department ("ECO") of an institution,
// the same way the in-app upgrade does (rules disabled).
export async function tagAll(admin, dept = "ECO", name = "Economics") {
  await admin(async db => {
    await db.doc(`departments/${dept}`).set({ name, programs: ["UG", "PG", "IG"] });
    await db.doc("config/institution").set({ adminUid: "admin-none", name: "Test College", migratedAt: "seed" });
    for (const c of ["batches", "subjects", "enrollments", "subjectAssignments", "teachers", "students", "attendance",
                     "classCancellations", "correctionRequests", "attendanceCorrections", "leaves", "studentViews", "loginNames"]) {
      const snap = await db.collection(c).get();
      for (const d of snap.docs) if (!("departmentId" in d.data())) await d.ref.update({ departmentId: dept });
    }
    for (const d of (await db.collection("users").get()).docs) {
      if (["HOD", "Teacher", "Student"].includes(d.data().role) && !d.data().departmentId) await d.ref.update({ departmentId: dept });
    }
    for (const d of (await db.collection("dayStatuses").get()).docs) {
      if (!("departmentId" in d.data())) { const date = d.data().date || d.id; await db.doc(`dayStatuses/${dept}_${date}`).set({ ...d.data(), date, departmentId: dept }); await d.ref.delete(); }
    }
  });
}
