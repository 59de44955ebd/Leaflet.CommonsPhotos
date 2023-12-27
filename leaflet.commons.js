/* Show geotagged Wikimedia Commons photos on a Leaflet map
*
* Requirements:
*	https://github.com/turban/Leaflet.Photo/
*	https://github.com/Leaflet/Leaflet.markercluster/
**/

(function(){

if (L.MarkerClusterGroup && L.Photo.Cluster) {

	const RE_SPACE = new RegExp(' ', 'g');
	const SUPPORTED_FILE_TYPES = ['jpg', 'jpeg', 'png'];
	const MAX_BBOX_SQUARE_METERS = 400000000;

	// MD5 stuff
	const hs = [...Array(16)].map((_, i) => i.toString(16));
	const hex2s = (hs.join("") + hs.reverse().join("")).match(/../g);
	const H = new Uint32Array(Uint8Array.from(hex2s, v => parseInt(v, 16)).buffer);
	const K = Uint32Array.from(
	    Array(64), (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * (2 ** 32)));
	const S = [[7, 12, 17, 22], [5, 9, 14, 20], [4, 11, 16, 23], [6, 10, 15, 21]];
	const F = [
	    (b, c, d) => ((b & c) | ((~b >>> 0) & d)) >>> 0,
	    (b, c, d) => ((d & b) | ((~d >>> 0) & c)) >>> 0,
	    (b, c, d) => (b ^ c ^ d) >>> 0,
	    (b, c, d) => (c ^ (b | (~d >>> 0))) >>> 0,
	];
	const J = [
	    i => i,
	    i => (5 * i + 1) % 16,
	    i => (3 * i + 5) % 16,
	    i => (7 * i) % 16,
	];
	const rotl = function(v, n) {
	    return ((v << n) | (v >>> (32 - n))) >>> 0;
	};

	L.CommonsPhotos = L.Photo.Cluster.extend({

		options: {
			minZoom: 10,
			maxImagesPerRequest: 60,
			thumbSize: 100,
			imageSize: 640,
			updateMinPixelDistance: 60,
			imageClickClosesPopup: true,

			// MarkerClusterGroup options

			// The maximum radius that a cluster will cover from the central marker (in pixels).
			// Default 80. Decreasing will make more, smaller clusters.
			maxClusterRadius: 50,

			// When you mouse over a cluster it shows the bounds of its markers.
			showCoverageOnHover: true,

			// Increase from 1 to increase the distance away from the center that spiderfied markers are placed.
			// Use if you are using big marker icons (Default: 1).
			spiderfyDistanceMultiplier: 2,
		},

		initialize: function (options) {
			L.setOptions(this, options);
			L.Photo.Cluster.prototype.initialize.call(this);

			this._done = {};

			this.on('click',  (evt) => {
				let img;
				const popup = L.popup({
					content: () => {
						const div = document.createElement('div');
						img = document.createElement('img');
						img.src = evt.layer.photo.image;
						div.appendChild(img);
						const p = document.createElement('p');
						p.innerHTML = `<a href="${evt.layer.photo.link}" target="_blank">${evt.layer.photo.title}</a>`;
						div.appendChild(p);
						if (this.options.imageClickClosesPopup)
							div.style.cursor = 'pointer';
						return div;
					},
			 	   	className: 'leaflet-popup-photo',
					minWidth: this.options.imageSize - 1,
					closeButton: false,
					autoClose: false,
				});

				evt.layer.bindPopup(popup).openPopup();
				img.onload = () => popup._adjustPan();
				if (this.options.imageClickClosesPopup)
					img.onclick = () => popup.close();
			});

			this._controller = null;
			this._prevZoom = -1;
			this._shownall = false;
			this._prevPoint = null;
			this._totalImages = null;

			// Used to turn off unspiderfying when new photos are added (unfortunately MarkerClusterGroup has no public API for this)
			this.__unspiderfy = this._unspiderfy;
		},

		onAdd: function (map) {
			L.Photo.Cluster.prototype.onAdd.call(this, map);
			this._map = map;
			map.on('moveend', this._requestData, this);
			this._requestData();
		},

		onRemove: function (map) {
			L.Photo.Cluster.prototype.onRemove.call(this,map);
			map.off('moveend', this._requestData, this);
			this.clear();
			this._done = {};
			this._shownall = false;
			this._prevPoint = null;
		},

		_requestData: function () {
			const zoom = this._map.getZoom();
			if (zoom < this.options.minZoom)
				return;

			const p = this._map.getPixelBounds().min;
			if (this._prevPoint && zoom == this._prevZoom)
			{
				if (p.distanceTo(this._prevPoint) < this.options.updateMinPixelDistance)
				{
					return false;
				}
			}
			this._prevPoint = p;

			if (this._controller)
			{
				this._controller.abort();
				this._controller = null;
			}

			if (!this._shownall || this._map.getZoom() <= this._prevZoom)
			{
				let bounds = this._map.getBounds();

				// if bbox is bigger than wikimedia allows, decrease it
				while (this._map.distance(bounds.getNorthWest(), bounds.getNorthEast()) * this._map.distance(bounds.getNorthWest(), bounds.getSouthWest()) > MAX_BBOX_SQUARE_METERS)
				{
					bounds = bounds.pad(-.1);
				}
				const gsbbox = bounds.getNorth() + '|' +  bounds.getWest() + '|' + bounds.getSouth() + '|' + bounds.getEast();
				this._controller = new AbortController();
				fetch(`https://commons.wikimedia.org/w/api.php?format=json&action=query&list=geosearch&gsprimary=all&gsnamespace=6&gslimit=${this.options.maxImagesPerRequest}&gsbbox=${gsbbox}&origin=*`,
				{
					signal: this._controller.signal,
				})
				.then(res => res.json())
				.then(data => {
					this._controller = null;
					this._addRows(data.query.geosearch);
					this._shownall = true;
				})
				.catch(err => {
	                this._controller = null;
	            });
			}
			this._prevZoom = zoom;
		},

		_addRows: function(rows) {
			const newRows = [];
			let file, md5, c1, c2;
			for (let row of rows)
			{
				if (!SUPPORTED_FILE_TYPES.includes(row.title.split('.').pop().toLowerCase()))
					continue;
				if (!this._done[row.pageid])
				{
					file = this._replaceSpaces(row.title.substr(5));
					md5 = this._md5_hex(file);

					row.thumbnail = `https://upload.wikimedia.org/wikipedia/commons/thumb/${md5.charAt(0)}/${md5}/${file}/${this.options.thumbSize}px-${file}`;
					row.image = `https://upload.wikimedia.org/wikipedia/commons/thumb/${md5.charAt(0)}/${md5}/${file}/${this.options.imageSize}px-${file}`;
					row.link = 'https://commons.wikimedia.org/wiki/' + row.title;

					newRows.push(row);
					this._done[row.pageid] = 1;
				}
			}

			this._unspiderfy = null;
			this.add(newRows);
			this._unspiderfy = this.__unspiderfy;
		},

		_replaceSpaces: function(str) {
			return str.replace(RE_SPACE, '_');
		},

		// returns first 2 chars of md5 hex string
		_md5_hex: function (str) {
			const u8a = (new TextEncoder()).encode(str);
		    const total = Math.ceil((u8a.length + 9) / 64) * 64;
		    const chunks = new Uint8Array(total);
		    chunks.set(u8a);
		    chunks.fill(0, u8a.length);
		    chunks[u8a.length] = 0x80;
		    const lenbuf = new Uint32Array(chunks.buffer, total - 8);
		    const low = u8a.length % (1 << 29);
		    const high = (u8a.length - low) / (1 << 29);
		    lenbuf[0] = low << 3;
		    lenbuf[1] = high;
		    const hash = H.slice();
		    for (let offs = 0; offs < total; offs += 64)
		    {
		        const w = new Uint32Array(chunks.buffer, offs, 16);
		        let [a, b, c, d] = hash;
		        for (let s = 0; s < 4; s++)
		        {
		            for (let i = s * 16, end = i + 16; i < end; i++)
		            {
		                const t = a + F[s](b, c, d) + K[i] + w[J[s](i)];
		                const na = (b + rotl(t >>> 0, S[s][i % 4])) >>> 0;
		                [a, b, c, d] = [d, na, b, c];
		            }
		        }
		        hash[0] += a; hash[1] += b; hash[2] += c; hash[3] += d;
		    }
			return [...new Uint8Array(hash.buffer, 0, 1)][0].toString(16).padStart(2, '0');
		},

	});

	L.commonsPhotos = function (options) {
		return new L.CommonsPhotos(options);
	};
}

})();
