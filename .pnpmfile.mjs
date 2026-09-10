export const hooks = {
  readPackage(pkg) {
    // pnpm 11 otherwise binds this optional peer to the applications' Zod 3.
    // Install the Zod 4 API required by better-call's OpenAPI implementation.
    if (pkg.name === "better-call" && pkg.version === "1.4.0") {
      pkg.dependencies = { ...pkg.dependencies, zod: "4.4.3" };
      delete pkg.peerDependencies?.zod;
      delete pkg.peerDependenciesMeta?.zod;
    }
    return pkg;
  },
};
