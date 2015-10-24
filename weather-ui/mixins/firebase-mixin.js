import 'firebase';


export default function(path){

	var _base = new Firebase(path);

	return {
		methods: {
			fb_init(callback){
				_base.once('value', (snapshot) => {
					if(callback){
						callback();
					}
				});
				_base.on("child_added", (snapshot, prevChildKey) => {
					this.$set(snapshot.key(), snapshot.val());
				});
				_base.on("child_changed", (snapshot) => {
					this.$set(snapshot.key(),snapshot.val());
				});
				_base.on("child_removed", (snapshot) => {
					this.$delete(snapshot.key());
				});
			},
			fb_dispose(){
				_base.off();
			},
			fb_add(value, callback){
				return _base.push(value, callback);
			},
			fb_set(value, callback){
				return _base.set(value, callback);
			},
			fb_remove(key, callback){
				_base.child(key).remove(callback);
			}
		}
	};
}