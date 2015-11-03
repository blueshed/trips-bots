import './main.css!';
import 'dropzone/dist/min/basic.min.css!';
import tmpl from './main-tmpl.html!text';
import firebase_mixin from 'mixins/firebase-mixin';
import Vue from 'vue';
import Dropzone from 'dropzone';


Vue.component('photo-panel', {
  	template: tmpl,
  	data: function(){
  		return {
            photos: []
        };
  	},
  	props: [
        'base'
    ],
  	methods:{
        get_photo(uid){
            return this.photos.find((photo)=>{
                return photo.uid == uid;
            });
        }
    },
    computed:{
        sorted_photos(){
            return this.photos.sort((a,b)=>{
                return a.val.date - b.val.date;
            });
        }
    },
    ready(){
        var fb = new Firebase(this.base);
  		fb.on('value', value=>{});
  		fb.on("child_added", value => {
  			var photo = this.get_photo(value.key());
  			if(!photo){
				  this.photos.push({uid:value.key(),val: value.val()});
  			}
  		});
        this.$nextTick( () => {
            this.$dropzone = new Dropzone("#my-awesome-dropzone", { url: "/upload"});
        });
    }
});
