pm.test('Identity route requires authentication', () => {
  pm.expect(pm.response.code).to.equal(401);
  pm.expect(pm.response.json().code).to.equal('unauthenticated');
});
