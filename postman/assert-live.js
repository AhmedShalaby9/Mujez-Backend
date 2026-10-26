pm.test('Liveness is healthy', () => {
  pm.expect(pm.response.code).to.equal(200);
  pm.expect(pm.response.json()).to.eql({status:'ok'});
});
